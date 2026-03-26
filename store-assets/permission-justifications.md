# Permission Justifications for Chrome Web Store Review

Use these responses when Chrome Web Store asks why each permission is needed.

## activeTab

"The extension needs to access the active tab to scan the page content for video elements when the user clicks the extension icon or when the content script runs."

## scripting

"The extension injects a content script to scan the DOM for video elements (HTML5 video tags, iframe embeds, and anchor links to video files). This is the core detection functionality."

## storage

"The extension uses Chrome session storage to maintain a per-tab list of detected videos. This data is temporary and cleared when the tab is closed or the browser restarts. No persistent data is stored."

## downloads

"When the user clicks the Download button in the extension popup, the extension uses the Chrome downloads API to save the video file to the user's computer. This is the core download functionality."

## webRequest

"The extension monitors network requests to detect video files loaded by JavaScript streaming APIs (such as Reddit's DASH video player or Twitter's video CDN). Many modern sites load videos programmatically rather than using visible HTML elements, so DOM scanning alone cannot detect them. The extension only observes request URLs — it does not modify, block, or redirect any requests."

## webNavigation

"The extension listens for navigation events to clear stale video detection data when the user navigates to a new page within the same tab. This prevents showing videos from a previously visited page."

## Host permissions (<all_urls> / http/https)

"The extension needs to run its content script on all websites because users may encounter downloadable videos on any site. The extension scans for HTML5 video elements, video embed iframes, and video file links. It also monitors network requests for video file URLs from any domain. The extension does not collect, store, or transmit any user data — all processing happens locally in the browser."

## Single Purpose Description

"EasyVideoSnag detects and downloads videos from web pages. It scans page content and network requests to find video sources, displays them in a popup, and lets users download them with one click."
