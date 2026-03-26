// EasyVideoSnag - Content Script
// Detects video elements and common video sources on the page.
// Works alongside background.js network interception for full coverage.

(function () {
  "use strict";

  // Track last sent video list to avoid duplicate messages.
  let lastSentSignature = "";

  function detectVideos() {
    const found = new Map();

    // 1. <video> elements (direct src or <source> children)
    document.querySelectorAll("video").forEach((video) => {
      const sources = [];

      if (video.src && !video.src.startsWith("blob:")) {
        sources.push(video.src);
      }

      video.querySelectorAll("source").forEach((source) => {
        if (source.src && !source.src.startsWith("blob:")) {
          sources.push(source.src);
        }
      });

      const dataSrc = video.getAttribute("data-src") || video.getAttribute("data-video-src");
      if (dataSrc && !dataSrc.startsWith("blob:")) {
        sources.push(dataSrc);
      }

      sources.forEach((src) => {
        if (!found.has(src)) {
          found.set(src, {
            src,
            title: deriveTitle(src, video),
            type: deriveType(src),
            source: "dom"
          });
        }
      });
    });

    // 2. <a> links to video files
    document.querySelectorAll("a[href]").forEach((a) => {
      const href = a.href;
      if (isVideoFileUrl(href) && !found.has(href)) {
        found.set(href, {
          src: href,
          title: a.textContent.trim() || deriveTitle(href),
          type: deriveType(href),
          source: "dom"
        });
      }
    });

    // 4. Reddit: extract video URL from embedded JSON data
    if (window.location.hostname.includes("reddit.com")) {
      extractRedditVideos(found);
    }

    // 5. Twitter/X: extract video from page data
    if (window.location.hostname.includes("twitter.com") ||
        window.location.hostname.includes("x.com")) {
      extractTwitterVideos(found);
    }

    return Array.from(found.values());
  }

  // ---------------------------------------------------------------------------
  // Reddit
  // ---------------------------------------------------------------------------

  function extractRedditVideos(found) {
    const pageTitle = document.querySelector('meta[property="og:title"]')
      ?.getAttribute("content") || document.title || "Reddit Video";

    let foundGoodSource = false;

    // Method 1: shreddit-player with playbackMp4s (pre-muxed, includes audio)
    document.querySelectorAll("shreddit-player, shreddit-player-2").forEach((player) => {
      const jsonAttr = player.getAttribute("packaged-media-json")
        || player.getAttribute("src")
        || player.getAttribute("data-packaged-media-json");
      if (!jsonAttr) return;
      try {
        const data = JSON.parse(jsonAttr);
        if (data.playbackMp4s) {
          const mp4s = data.playbackMp4s.permutations || [];
          const best = mp4s.reduce((a, b) => {
            const aH = a?.source?.height || a?.height || 0;
            const bH = b?.source?.height || b?.height || 0;
            return bH > aH ? b : a;
          }, mp4s[0]);

          const url = best?.source?.url || best?.url;
          const height = best?.source?.height || best?.height || "";
          if (url && !found.has(url)) {
            found.set(url, {
              src: url,
              title: height ? `${pageTitle} (${height}p)` : pageTitle,
              type: "MP4",
              source: "dom"
            });
            foundGoodSource = true;
          }
        }
      } catch { /* not JSON */ }
    });

    if (foundGoodSource) return;

    // Method 2: JSON-LD script tags
    document.querySelectorAll('script[type="application/ld+json"]').forEach((script) => {
      try {
        const data = JSON.parse(script.textContent);
        const videoUrl = data.contentUrl || data.url;
        if (videoUrl && videoUrl.includes("v.redd.it") && !found.has(videoUrl)) {
          found.set(videoUrl, {
            src: videoUrl,
            title: data.name || pageTitle,
            type: deriveType(videoUrl),
            source: "dom"
          });
          foundGoodSource = true;
        }
      } catch { /* not valid JSON-LD */ }
    });

    if (foundGoodSource) return;

    // Method 3: og:video meta tag
    const ogVideo = document.querySelector('meta[property="og:video"]');
    if (ogVideo) {
      const url = ogVideo.getAttribute("content");
      if (url && !found.has(url)) {
        found.set(url, {
          src: url,
          title: pageTitle,
          type: deriveType(url),
          source: "dom"
        });
        foundGoodSource = true;
      }
    }

    if (foundGoodSource) return;

    // Method 4: Reddit JSON API (last resort)
    fetchRedditJsonApi(pageTitle);
  }

  function fetchRedditJsonApi(pageTitle) {
    const postMatch = window.location.pathname.match(/\/comments\/([a-z0-9]+)/i);
    if (!postMatch) return;

    const jsonUrl = window.location.pathname.replace(/\/?$/, ".json");
    fetch(jsonUrl, { credentials: "omit" })
      .then((r) => {
        if (!r.ok) throw new Error(r.status);
        return r.json();
      })
      .then((data) => {
        const post = data?.[0]?.data?.children?.[0]?.data;
        if (!post?.is_video) return;

        const rv = post.secure_media?.reddit_video || post.media?.reddit_video;
        if (!rv?.fallback_url) return;

        // Check stored videos to see if we already have a reddit video
        chrome.storage.session.get(null, (stored) => {
          const existingVideos = Object.values(stored).flat();
          const hasRedditVideo = existingVideos.some(
            (v) => v.src && (v.src.includes("v.redd.it") || v.src.includes("redd.it"))
          );
          if (hasRedditVideo) return;

          const fallbackUrl = rv.fallback_url;
          const height = rv.height || "unknown";
          const isGif = rv.is_gif || false;

          const video = {
            src: fallbackUrl,
            title: `${pageTitle} (${height}p${isGif ? "" : ", no audio"})`,
            type: "MP4",
            source: "dom"
          };

          chrome.runtime.sendMessage({
            type: "VIDEOS_FOUND",
            videos: [video]
          });
        });
      })
      .catch(() => { /* fetch failed */ });
  }

  // ---------------------------------------------------------------------------
  // Twitter/X
  // ---------------------------------------------------------------------------

  function extractTwitterVideos(found) {
    const ogVideo = document.querySelector('meta[property="og:video"]');
    if (ogVideo) {
      const url = ogVideo.getAttribute("content");
      if (url && !found.has(url)) {
        const ogTitle = document.querySelector('meta[property="og:title"]');
        found.set(url, {
          src: url,
          title: ogTitle?.getAttribute("content") || "Twitter Video",
          type: deriveType(url),
          source: "dom"
        });
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  function deriveTitle(src, element) {
    if (element) {
      const alt = element.getAttribute("alt") || element.getAttribute("title");
      if (alt) return alt;
    }
    try {
      const url = new URL(src);
      const segments = url.pathname.split("/").filter(Boolean);
      return segments.length > 0
        ? decodeURIComponent(segments[segments.length - 1])
        : url.hostname;
    } catch {
      return "Video";
    }
  }

  function deriveType(src) {
    const ext = src.split("?")[0].split(".").pop().toLowerCase();
    const types = {
      mp4: "MP4", webm: "WebM", ogg: "OGG", m3u8: "HLS",
      mpd: "DASH", mov: "MOV", avi: "AVI", mkv: "MKV"
    };
    return types[ext] || "Video";
  }

  function isVideoFileUrl(url) {
    return /\.(mp4|webm|ogg|mov|avi|mkv|m3u8|mpd)(\?|$)/i.test(url);
  }


  // ---------------------------------------------------------------------------
  // Scan and send
  // ---------------------------------------------------------------------------

  function scan() {
    const videos = detectVideos();

    // Skip sending if the video list hasn't changed since last scan.
    const signature = videos.map((v) => v.src).sort().join("|");
    if (signature === lastSentSignature) return;
    lastSentSignature = signature;

    chrome.runtime.sendMessage({ type: "VIDEOS_FOUND", videos });
  }

  // Initial scan
  scan();

  // Listen for rescan requests from the popup
  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === "RESCAN") {
      lastSentSignature = ""; // force re-send
      scan();
    }
  });

  // Observe DOM changes with debounce
  let scanTimeout;
  const observer = new MutationObserver(() => {
    clearTimeout(scanTimeout);
    scanTimeout = setTimeout(scan, 500);
  });

  if (document.body) {
    observer.observe(document.body, {
      childList: true,
      subtree: true
    });
  }
})();
