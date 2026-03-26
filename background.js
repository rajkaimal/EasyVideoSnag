// EasyVideoSnag - Background Service Worker
//
// Two detection layers:
// 1. DOM scanning (from content.js) — finds <video>, <iframe>, <a> elements
// 2. Network interception (this file) — catches video URLs loaded via
//    JavaScript streaming APIs (Reddit, Twitter/X, Instagram, etc.)

// Per-tab storage: maps tabId → Map<url, videoInfo>
const tabVideos = new Map();

// Video file patterns caught by network interception.
const VIDEO_URL_PATTERN = /\.(mp4|webm|ogg|mov|avi|mkv|ts)(\?|$)/i;

// DASH/HLS manifest patterns.
const MANIFEST_PATTERN = /\.(m3u8|mpd)(\?|$)/i;

// Known video CDN hosts where URL paths contain video content.
const VIDEO_CDN_HOSTS = [
  "v.redd.it",
  "video.twimg.com",
  "scontent.cdninstagram.com",
  "video-weaver.*.hls.ttvnw.net"
];

// Precompile CDN host matchers for performance — this runs on every request.
const CDN_MATCHERS = VIDEO_CDN_HOSTS.map((host) => {
  if (host.includes("*")) {
    return new RegExp("^" + host.replace(/\./g, "\\.").replace(/\*/g, ".*") + "$");
  }
  return host;
});

// ---------------------------------------------------------------------------
// Network interception
// ---------------------------------------------------------------------------

chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (details.tabId < 0) return;

    const url = details.url;
    if (url.startsWith("blob:") || url.startsWith("data:")) return;

    // Parse URL once, reuse for all checks.
    let hostname;
    try {
      hostname = new URL(url).hostname;
    } catch {
      return;
    }

    const isVideoFile = VIDEO_URL_PATTERN.test(url);
    const isManifest = MANIFEST_PATTERN.test(url);
    const isVideoCDN = CDN_MATCHERS.some((matcher) =>
      typeof matcher === "string" ? hostname === matcher : matcher.test(hostname)
    );

    if (!isVideoFile && !isManifest && !isVideoCDN) return;

    // Reddit: filter audio-only tracks and DASH/CMAF fragments.
    // Content script finds better pre-muxed sources.
    if (hostname === "v.redd.it") {
      if (/DASH_audio|DASH_AUDIO|CMAF_AUDIO/i.test(url)) return;
      if (/DASH_\d+|CMAF_\d+|m2-res_/i.test(url)) return;
    }

    addNetworkVideo(details.tabId, url, isManifest ? "manifest" : "file");
  },
  { urls: ["http://*/*", "https://*/*"], types: ["media", "xmlhttprequest", "other"] }
);

function addNetworkVideo(tabId, url, kind) {
  if (!tabVideos.has(tabId)) {
    tabVideos.set(tabId, new Map());
  }

  const videos = tabVideos.get(tabId);
  if (videos.has(url)) return;

  videos.set(url, {
    src: url,
    title: deriveTitleFromUrl(url),
    type: deriveTypeFromUrl(url),
    source: "network"
  });

  updateBadgeAndStorage(tabId);
}

function deriveTitleFromUrl(url) {
  try {
    const u = new URL(url);
    const segments = u.pathname.split("/").filter(Boolean);

    if (u.hostname === "v.redd.it" && segments.length >= 1) {
      const quality = segments[segments.length - 1].replace(/\.\w+$/, "");
      return `Reddit Video (${quality})`;
    }

    if (u.hostname === "video.twimg.com") {
      return "Twitter Video";
    }

    if (segments.length > 0) {
      return decodeURIComponent(segments[segments.length - 1]).replace(/\.\w+$/, "");
    }

    return u.hostname;
  } catch {
    return "Video";
  }
}

function deriveTypeFromUrl(url) {
  const ext = url.split("?")[0].split(".").pop().toLowerCase();
  const types = {
    mp4: "MP4", webm: "WebM", ogg: "OGG", m3u8: "HLS",
    mpd: "DASH", mov: "MOV", avi: "AVI", mkv: "MKV", ts: "TS"
  };
  return types[ext] || "Video";
}

// ---------------------------------------------------------------------------
// Merge network + DOM videos and update storage/badge
// ---------------------------------------------------------------------------

function updateBadgeAndStorage(tabId) {
  const networkVids = tabVideos.get(tabId);
  if (!networkVids) return;

  chrome.storage.session.get(String(tabId), (result) => {
    const domVideos = (result[tabId] || []).filter((v) => v.source !== "network");
    const networkList = Array.from(networkVids.values());

    const merged = new Map();
    [...domVideos, ...networkList].forEach((v) => {
      if (!merged.has(v.src)) {
        merged.set(v.src, v);
      }
    });

    const allVideos = Array.from(merged.values());

    chrome.storage.session.set({ [tabId]: allVideos });

    chrome.action.setBadgeText({
      tabId,
      text: allVideos.length > 0 ? String(allVideos.length) : ""
    });
    chrome.action.setBadgeBackgroundColor({ tabId, color: "#e74c3c" });

    // Notify popup if it's open
    chrome.runtime.sendMessage({ type: "VIDEOS_UPDATED" }).catch(() => {});
  });
}

// ---------------------------------------------------------------------------
// Messages from content script and popup
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "VIDEOS_FOUND") {
    const tabId = sender.tab.id;
    const domVideos = message.videos.map((v) => ({ ...v, source: "dom" }));
    const networkVids = tabVideos.get(tabId);
    const networkList = networkVids ? Array.from(networkVids.values()) : [];

    const merged = new Map();
    [...domVideos, ...networkList].forEach((v) => {
      if (!merged.has(v.src)) {
        merged.set(v.src, v);
      }
    });

    const allVideos = Array.from(merged.values());

    chrome.storage.session.set({ [tabId]: allVideos });

    chrome.action.setBadgeText({
      tabId,
      text: allVideos.length > 0 ? String(allVideos.length) : ""
    });
    chrome.action.setBadgeBackgroundColor({ tabId, color: "#e74c3c" });

    // Notify popup if it's open
    chrome.runtime.sendMessage({ type: "VIDEOS_UPDATED" }).catch(() => {});
  }

  if (message.type === "GET_VIDEOS") {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]) {
        chrome.storage.session.get(String(tabs[0].id), (result) => {
          sendResponse({ videos: result[tabs[0].id] || [] });
        });
      } else {
        sendResponse({ videos: [] });
      }
    });
    return true;
  }
});

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

// Clear per-tab data on tab close.
chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.session.remove(String(tabId));
  tabVideos.delete(tabId);
});

// Clear per-tab data on navigation (prevents stale videos from previous page).
chrome.webNavigation.onBeforeNavigate.addListener((details) => {
  // Only top-level navigations, not iframes
  if (details.frameId !== 0) return;
  chrome.storage.session.remove(String(details.tabId));
  tabVideos.delete(details.tabId);
  chrome.action.setBadgeText({ tabId: details.tabId, text: "" });
});

// Clear stale session data on extension startup (e.g., after browser crash).
chrome.runtime.onStartup.addListener(() => {
  chrome.storage.session.clear();
  tabVideos.clear();
});
