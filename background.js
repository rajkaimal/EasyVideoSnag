// EasyVideoSnag - Background Service Worker
//
// Two detection layers:
// 1. DOM scanning (from content.js) — finds <video>, <iframe>, <a> elements
// 2. Network interception (this file) — catches video URLs loaded via
//    JavaScript streaming APIs (Reddit, Twitter/X, Instagram, etc.)

// Per-tab storage: maps tabId → Map<url, videoInfo>
const tabVideos = new Map();

// Video file patterns caught by network interception.
// Matches actual video file requests, not manifests or API calls.
const VIDEO_URL_PATTERN = /\.(mp4|webm|ogg|mov|avi|mkv|ts)(\?|$)/i;

// DASH/HLS manifest patterns — these point to the video but aren't
// directly downloadable. We record the base URL to find the actual segments.
const MANIFEST_PATTERN = /\.(m3u8|mpd)(\?|$)/i;

// Known video CDN hosts where URL paths contain video content.
const VIDEO_CDN_HOSTS = [
  "v.redd.it",
  "video.twimg.com",
  "scontent.cdninstagram.com",
  "video-weaver.*.hls.ttvnw.net"
];

// Content types that indicate video responses.
const VIDEO_CONTENT_TYPES = [
  "video/mp4",
  "video/webm",
  "video/ogg",
  "application/vnd.apple.mpegurl",  // HLS
  "application/dash+xml"            // DASH
];

// ---------------------------------------------------------------------------
// Network interception
// ---------------------------------------------------------------------------

chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    // Only care about requests from tabs (not service workers, etc.)
    if (details.tabId < 0) return;

    const url = details.url;

    // Skip blob: and data: URLs — not downloadable
    if (url.startsWith("blob:") || url.startsWith("data:")) return;

    // Check if this is a video URL
    const isVideoFile = VIDEO_URL_PATTERN.test(url);
    const isManifest = MANIFEST_PATTERN.test(url);
    const isVideoCDN = VIDEO_CDN_HOSTS.some((host) => {
      if (host.includes("*")) {
        const regex = new RegExp(host.replace(/\./g, "\\.").replace(/\*/g, ".*"));
        return regex.test(new URL(url).hostname);
      }
      return new URL(url).hostname === host;
    });

    if (!isVideoFile && !isManifest && !isVideoCDN) return;

    // For Reddit: v.redd.it serves /DASH_720.mp4, /DASH_480.mp4, etc.
    // Filter out audio-only tracks (both old DASH and new CMAF formats).
    // Also skip DASH video fragments — the content script finds better
    // pre-muxed MP4s (with audio) via shreddit-player or the JSON API.
    if (url.includes("v.redd.it")) {
      if (/DASH_audio|DASH_AUDIO|CMAF_AUDIO/i.test(url)) return;
      if (/DASH_\d+|CMAF_\d+|m2-res_/i.test(url)) return; // skip DASH/CMAF fragments
    }

    addNetworkVideo(details.tabId, url, isManifest ? "manifest" : "file");
  },
  { urls: ["<all_urls>"], types: ["media", "xmlhttprequest", "other"] }
);

function addNetworkVideo(tabId, url, kind) {
  if (!tabVideos.has(tabId)) {
    tabVideos.set(tabId, new Map());
  }

  const videos = tabVideos.get(tabId);

  // Deduplicate by URL
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

    // Reddit: use the post ID from the path (e.g., /abc123/DASH_720.mp4)
    if (u.hostname === "v.redd.it" && segments.length >= 1) {
      const quality = segments[segments.length - 1].replace(/\.\w+$/, "");
      return `Reddit Video (${quality})`;
    }

    // Twitter: video.twimg.com paths have meaningful names
    if (u.hostname === "video.twimg.com") {
      return "Twitter Video";
    }

    // Generic: last path segment
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

  // Get existing DOM-detected videos, merge with network-detected
  chrome.storage.session.get(String(tabId), (result) => {
    const domVideos = (result[tabId] || []).filter((v) => v.source !== "network");
    const networkList = Array.from(networkVids.values());

    // Deduplicate across both sources
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
  });
}

// ---------------------------------------------------------------------------
// Messages from content script and popup
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "VIDEOS_FOUND") {
    const tabId = sender.tab.id;

    // Tag DOM videos with source
    const domVideos = message.videos.map((v) => ({ ...v, source: "dom" }));

    // Merge with any network-detected videos
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
    return true; // keep channel open for async response
  }
});

// Clean up stored data when a tab is closed
chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.session.remove(String(tabId));
  tabVideos.delete(tabId);
});
