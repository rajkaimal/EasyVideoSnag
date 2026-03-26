// EasyVideoSnag - Popup Script

const videoListEl = document.getElementById("video-list");
const statusEl = document.getElementById("status");
const emptyStateEl = document.getElementById("empty-state");
const rescanBtn = document.getElementById("rescan-btn");

document.addEventListener("DOMContentLoaded", () => {
  loadVideos();
});

rescanBtn.addEventListener("click", () => {
  // Tell the content script to rescan
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs[0]) {
      chrome.tabs.sendMessage(tabs[0].id, { type: "RESCAN" });
      // Brief delay then reload the list
      statusEl.classList.remove("hidden");
      emptyStateEl.classList.add("hidden");
      videoListEl.innerHTML = "";
      setTimeout(loadVideos, 1000);
    }
  });
});

function loadVideos() {
  chrome.runtime.sendMessage({ type: "GET_VIDEOS" }, (response) => {
    statusEl.classList.add("hidden");

    const videos = response?.videos || [];

    if (videos.length === 0) {
      emptyStateEl.classList.remove("hidden");
      return;
    }

    emptyStateEl.classList.add("hidden");
    renderVideos(videos);
  });
}

function renderVideos(videos) {
  videoListEl.innerHTML = "";

  videos.forEach((video, index) => {
    const item = document.createElement("div");
    item.className = "video-item";

    const info = document.createElement("div");
    info.className = "video-info";

    const title = document.createElement("div");
    title.className = "title";
    title.textContent = video.title || `Video ${index + 1}`;

    const meta = document.createElement("div");
    meta.className = "meta";
    meta.textContent = video.type || "Unknown format";

    info.appendChild(title);
    info.appendChild(meta);

    const downloadBtn = document.createElement("button");
    downloadBtn.className = "btn btn-primary";
    downloadBtn.textContent = "Download";
    downloadBtn.addEventListener("click", () => {
      const name = sanitizeFilename(video.title || `video_${index + 1}`);
      const ext = deriveExtension(video.src, video.type);
      const filename = name.endsWith(ext) ? name : name + ext;
      chrome.downloads.download({ url: video.src, filename });
    });

    item.appendChild(info);
    item.appendChild(downloadBtn);
    videoListEl.appendChild(item);
  });
}

function sanitizeFilename(name) {
  // Strip any existing extension so we can add the correct one later
  const stripped = name.replace(/\.\w{2,5}$/, "");
  return stripped.replace(/[^a-z0-9_\-. ]/gi, "_").substring(0, 100);
}

function deriveExtension(url, type) {
  // Try to get extension from URL
  try {
    const pathname = new URL(url).pathname;
    const match = pathname.match(/\.(\w{2,5})$/);
    if (match) return "." + match[1].toLowerCase();
  } catch { /* ignore */ }

  // Fall back to type label
  const typeMap = {
    "MP4": ".mp4", "WebM": ".webm", "OGG": ".ogg", "MOV": ".mov",
    "AVI": ".avi", "MKV": ".mkv", "HLS": ".m3u8", "DASH": ".mpd",
    "TS": ".ts", "Video": ".mp4"
  };
  return typeMap[type] || ".mp4";
}
