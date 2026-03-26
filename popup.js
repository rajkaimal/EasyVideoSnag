// EasyVideoSnag - Popup Script

const videoListEl = document.getElementById("video-list");
const statusEl = document.getElementById("status");
const emptyStateEl = document.getElementById("empty-state");
const rescanBtn = document.getElementById("rescan-btn");

document.addEventListener("DOMContentLoaded", () => {
  loadVideos();
});

// Listen for live updates from background (network-detected videos arriving)
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "VIDEOS_UPDATED") {
    loadVideos();
  }
});

rescanBtn.addEventListener("click", () => {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs[0]) {
      chrome.tabs.sendMessage(tabs[0].id, { type: "RESCAN" });
      statusEl.classList.remove("hidden");
      emptyStateEl.classList.add("hidden");
      videoListEl.innerHTML = "";
      // Content script will send VIDEOS_FOUND which triggers VIDEOS_UPDATED
      // Use a fallback timeout in case the message doesn't arrive
      setTimeout(loadVideos, 2000);
    }
  });
});

function loadVideos() {
  chrome.runtime.sendMessage({ type: "GET_VIDEOS" }, (response) => {
    statusEl.classList.add("hidden");

    const videos = response?.videos || [];

    if (videos.length === 0) {
      emptyStateEl.classList.remove("hidden");
      videoListEl.innerHTML = "";
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

      downloadBtn.textContent = "Starting...";
      downloadBtn.disabled = true;

      chrome.downloads.download({ url: video.src, filename }, (downloadId) => {
        if (chrome.runtime.lastError || !downloadId) {
          downloadBtn.textContent = "Failed";
          downloadBtn.classList.add("btn-failed");
          setTimeout(() => {
            downloadBtn.textContent = "Retry";
            downloadBtn.classList.remove("btn-failed");
            downloadBtn.disabled = false;
          }, 2000);
        } else {
          downloadBtn.textContent = "Done";
          downloadBtn.classList.add("btn-success");
          setTimeout(() => {
            downloadBtn.textContent = "Download";
            downloadBtn.classList.remove("btn-success");
            downloadBtn.disabled = false;
          }, 2000);
        }
      });
    });

    item.appendChild(info);
    item.appendChild(downloadBtn);
    videoListEl.appendChild(item);
  });
}

function sanitizeFilename(name) {
  // Strip any existing extension so we can add the correct one later.
  const stripped = name.replace(/\.\w{2,5}$/, "");
  // Keep Unicode letters, digits, spaces, hyphens, underscores, dots.
  // Only strip filesystem-unsafe characters.
  return stripped.replace(/[\/\\:*?"<>|]/g, "_").substring(0, 100);
}

function deriveExtension(url, type) {
  try {
    const pathname = new URL(url).pathname;
    const match = pathname.match(/\.(\w{2,5})$/);
    if (match) return "." + match[1].toLowerCase();
  } catch { /* ignore */ }

  const typeMap = {
    "MP4": ".mp4", "WebM": ".webm", "OGG": ".ogg", "MOV": ".mov",
    "AVI": ".avi", "MKV": ".mkv", "HLS": ".m3u8", "DASH": ".mpd",
    "TS": ".ts", "Video": ".mp4"
  };
  return typeMap[type] || ".mp4";
}
