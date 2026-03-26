# EasyVideoSnag

A Chrome extension that detects and downloads videos from any webpage. Two detection layers work together: DOM scanning finds visible video elements, network interception catches videos loaded behind the scenes by JavaScript streaming APIs.

Works on Reddit, Twitter/X, Vimeo, Dailymotion, and any site with standard HTML5 video.

---

## How It Works

```mermaid
graph TB
    subgraph page ["Webpage"]
        V1["&lt;video&gt; elements"]
        V2["&lt;iframe&gt; embeds"]
        V3["&lt;a&gt; video links"]
        V4["Page metadata\n(og:video, JSON-LD)"]
        V5["JavaScript-loaded\nstreaming video"]
    end

    subgraph ext ["EasyVideoSnag"]
        CS["content.js\n(DOM Scanner)"]
        BG["background.js\n(Network Interceptor)"]
        ST["Session Storage\n(per-tab video list)"]
        PO["popup.js\n(UI)"]
    end

    V1 --> CS
    V2 --> CS
    V3 --> CS
    V4 --> CS
    V5 -->|"network requests\ncaught by webRequest"| BG

    CS -->|"VIDEOS_FOUND"| BG
    BG -->|"merge + dedupe"| ST
    PO -->|"GET_VIDEOS"| BG
    BG -->|"video list"| PO
    PO -->|"chrome.downloads"| DL["Download"]

    style page fill:#1a1a2e,color:#eee
    style ext fill:#16213e,color:#eee
```

### Two Detection Layers

**Layer 1: DOM Scanning** (`content.js`)

Runs on every page. Scans the DOM for video sources:

| What it finds | How |
|---|---|
| HTML5 videos | `<video src>` and `<source>` children |
| Embedded videos | `<iframe>` pointing to YouTube, Vimeo, Dailymotion, Twitch, Streamable, Facebook, TikTok |
| Direct links | `<a href>` to `.mp4`, `.webm`, `.ogg`, `.mov`, `.avi`, `.mkv`, `.m3u8`, `.mpd` |
| Data attributes | `data-src`, `data-video-src` on `<video>` elements |
| Reddit videos | `shreddit-player` JSON data, JSON-LD, `og:video`, Reddit JSON API |
| Twitter/X videos | `og:video` meta tags |

**Layer 2: Network Interception** (`background.js`)

Catches video file requests that never appear in the DOM:

| What it catches | How |
|---|---|
| Video file requests | URLs matching `.mp4`, `.webm`, `.ogg`, `.mov`, `.avi`, `.mkv`, `.ts` |
| Streaming manifests | `.m3u8` (HLS) and `.mpd` (DASH) |
| Known CDN traffic | `v.redd.it`, `video.twimg.com`, Instagram CDN, Twitch video servers |

Both layers merge into a single deduplicated list per tab.

---

## Detection Flow

```mermaid
sequenceDiagram
    participant Page as Webpage
    participant CS as content.js
    participant BG as background.js
    participant Store as Session Storage
    participant Popup as popup.js

    Note over Page,Popup: Page loads

    Page->>CS: document_idle fires
    CS->>CS: Scan DOM for videos
    CS->>BG: VIDEOS_FOUND (DOM results)

    Page->>BG: Network requests (mp4, webm, etc.)
    BG->>BG: Filter: skip blob/data URLs,<br/>skip Reddit audio tracks,<br/>skip DASH fragments

    BG->>BG: Merge DOM + network videos
    BG->>Store: Save merged list (keyed by tab ID)
    BG->>BG: Update badge count

    Note over Page,Popup: DOM changes (SPA navigation, lazy load)

    Page->>CS: MutationObserver fires (debounced 500ms)
    CS->>CS: Rescan DOM
    CS->>CS: Compare signature with last scan
    alt Video list changed
        CS->>BG: VIDEOS_FOUND (updated)
        BG->>Store: Update merged list
        BG->>Popup: VIDEOS_UPDATED
    else No change
        CS->>CS: Skip (no message sent)
    end

    Note over Page,Popup: User clicks extension icon

    Popup->>BG: GET_VIDEOS
    BG->>Store: Read tab's video list
    Store-->>BG: Video array
    BG-->>Popup: Response with videos
    Popup->>Popup: Render video list with download buttons
```

---

## Reddit Video Detection

Reddit is the most complex case. Videos are served as DASH streams with separate audio and video tracks. The extension uses a priority cascade to find the best downloadable source:

```mermaid
flowchart TD
    A[Reddit page detected] --> B{shreddit-player\nplaybackMp4s?}
    B -->|Yes| C["Pre-muxed MP4\n(video + audio)\nBest quality"]
    B -->|No| D{JSON-LD\ncontentUrl?}
    D -->|Yes| E["Direct v.redd.it URL"]
    D -->|No| F{"og:video\nmeta tag?"}
    F -->|Yes| G["Meta tag URL"]
    F -->|No| H["Fetch Reddit JSON API\n(post_url.json)"]
    H --> I{"fallback_url\nin response?"}
    I -->|Yes| J["Video-only MP4\n(labeled 'no audio')"]
    I -->|No| K["No video found\n(rely on network layer)"]

    C --> DONE["Show in popup"]
    E --> DONE
    G --> DONE
    J --> DONE

    style C fill:#27ae60,color:#fff
    style J fill:#f39c12,color:#fff
    style K fill:#e74c3c,color:#fff
```

**Why the cascade matters:**

| Method | Has audio? | Reliability | Quality |
|---|---|---|---|
| `playbackMp4s` (shreddit-player) | Yes | High (when present) | Best |
| JSON-LD `contentUrl` | Varies | Medium | Good |
| `og:video` meta tag | Varies | Medium | Good |
| Reddit JSON API `fallback_url` | No | High | Good (video-only) |
| Network-intercepted DASH segments | No | High | Fragment only |

The extension stops at the first successful method. Network-intercepted Reddit DASH fragments (`DASH_720.mp4`, `CMAF_1080.mp4`) are filtered out in `background.js` because the content script finds better pre-muxed sources.

---

## Download Flow

```mermaid
sequenceDiagram
    participant User
    participant Popup as popup.js
    participant Chrome as chrome.downloads

    User->>Popup: Click "Download"
    Popup->>Popup: Sanitize filename<br/>(keep Unicode, strip unsafe chars)
    Popup->>Popup: Derive file extension<br/>(from URL or video type)
    Popup->>Popup: Button → "Starting..."

    Popup->>Chrome: chrome.downloads.download({url, filename})

    alt Download succeeds
        Chrome-->>Popup: downloadId returned
        Popup->>Popup: Button → "Done" (green, 2s)
        Popup->>Popup: Button → "Download" (reset)
    else Download fails
        Chrome-->>Popup: lastError or no downloadId
        Popup->>Popup: Button → "Failed" (gray, 2s)
        Popup->>Popup: Button → "Retry" (reset)
    end
```

### Filename Handling

```
Video title: "Let me try : r/funny (1280p)"
    ↓ sanitizeFilename()
    Strip filesystem-unsafe chars: / \ : * ? " < > |
    Keep Unicode letters, accents, CJK
    Truncate to 100 characters
    ↓
    "Let me try _ r_funny (1280p)"
    ↓ deriveExtension()
    Check URL path for extension → .mp4
    ↓
    "Let me try _ r_funny (1280p).mp4"
```

---

## Lifecycle and Cleanup

```mermaid
stateDiagram-v2
    [*] --> Idle: Extension installed

    Idle --> Scanning: Tab loads page
    Scanning --> Detecting: content.js scans DOM
    Scanning --> Intercepting: background.js catches requests

    Detecting --> Merged: VIDEOS_FOUND message
    Intercepting --> Merged: addNetworkVideo()

    Merged --> BadgeUpdated: Update badge count
    Merged --> StorageUpdated: Save to session storage

    BadgeUpdated --> Listening: Wait for DOM changes
    Listening --> Scanning: MutationObserver fires

    state "Cleanup" as cleanup {
        TabClosed --> Cleared: onRemoved
        Navigation --> Cleared: onBeforeNavigate
        BrowserRestart --> Cleared: onStartup
    }

    Merged --> TabClosed: User closes tab
    Merged --> Navigation: User navigates away
```

**Three cleanup triggers prevent stale data:**

| Event | What's cleared | Why |
|---|---|---|
| `tabs.onRemoved` | Session storage + tabVideos Map | Tab closed |
| `webNavigation.onBeforeNavigate` | Session storage + tabVideos Map + badge | User navigates to a new page in the same tab |
| `runtime.onStartup` | All session storage + tabVideos Map | Browser restarted (crash recovery) |

---

## Architecture

```
EasyVideoSnag/
├── manifest.json        # Extension config (Manifest V3)
├── background.js        # Service worker: network interception, storage, badge
├── content.js           # Content script: DOM scanning, site-specific extractors
├── popup.html           # Popup markup
├── popup.js             # Popup logic: render videos, handle downloads
├── popup.css            # Dark theme styling
└── icons/
    ├── icon16.png       # Toolbar icon
    ├── icon48.png       # Extensions page
    └── icon128.png      # Chrome Web Store
```

### Permissions

| Permission | Why |
|---|---|
| `activeTab` | Access the current tab to inject content script |
| `scripting` | Programmatic script injection |
| `storage` | Session storage for per-tab video lists |
| `downloads` | Trigger file downloads |
| `webRequest` | Intercept network requests to catch streaming video URLs |
| `webNavigation` | Detect in-tab navigation for cleanup |
| `http/https (host)` | Run content script and intercept requests on all websites |

### Message Protocol

```mermaid
graph LR
    CS[content.js] -->|"VIDEOS_FOUND\n{videos: [...]}""| BG[background.js]
    BG -->|"RESCAN"| CS
    PO[popup.js] -->|"GET_VIDEOS"| BG
    BG -->|"{videos: [...]}"| PO
    BG -->|"VIDEOS_UPDATED"| PO

    style CS fill:#e74c3c,color:#fff
    style BG fill:#2980b9,color:#fff
    style PO fill:#27ae60,color:#fff
```

| Message | From | To | Purpose |
|---|---|---|---|
| `VIDEOS_FOUND` | content.js | background.js | Report detected videos from DOM scan |
| `GET_VIDEOS` | popup.js | background.js | Request current video list for active tab |
| `RESCAN` | popup.js | content.js (via background) | Trigger a fresh DOM scan |
| `VIDEOS_UPDATED` | background.js | popup.js | Notify popup that the video list changed (live update) |

---

## Supported Formats

| Format | Extension | Type Label | Downloadable? |
|---|---|---|---|
| MP4 | `.mp4` | MP4 | Yes |
| WebM | `.webm` | WebM | Yes |
| OGG | `.ogg` | OGG | Yes |
| MOV | `.mov` | MOV | Yes |
| AVI | `.avi` | AVI | Yes |
| MKV | `.mkv` | MKV | Yes |
| MPEG-TS | `.ts` | TS | Yes |
| HLS Manifest | `.m3u8` | HLS | Detected (not directly downloadable) |
| DASH Manifest | `.mpd` | DASH | Detected (not directly downloadable) |

---

## Limitations

- **DRM-protected content** (Netflix, Disney+, Hulu) cannot be detected or downloaded. These use Encrypted Media Extensions (EME) which the browser decrypts in a protected pipeline.
- **Some sites block direct downloads** via CORS headers or signed URLs that expire. The download may fail with a network error.
- **Reddit videos via `fallback_url`** are video-only (no audio). The `playbackMp4s` path provides full video with audio when available.
- **Blob URLs** (`blob:https://...`) are skipped because they reference in-memory data that cannot be downloaded via URL.

---

## Install

1. Clone or download this repo
2. Open `chrome://extensions` in Chrome
3. Enable "Developer mode" (top right toggle)
4. Click "Load unpacked" and select the `EasyVideoSnag` folder
5. The extension icon appears in the toolbar

---

## License

MIT
