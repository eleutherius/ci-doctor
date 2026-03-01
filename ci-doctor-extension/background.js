/**
 * TraceFix — Background Service Worker (Manifest V3)
 *
 * Listens for a click on the extension icon and tells the active tab's
 * content script to run the analysis.
 */

chrome.action.onClicked.addListener(async (tab) => {
  // Guard: only run on GitHub pages
  if (!tab.url || !tab.url.startsWith("https://github.com/")) {
    console.warn("[TraceFix] Not a GitHub page — skipping.");
    return;
  }

  try {
    await chrome.tabs.sendMessage(tab.id, { action: "analyze" });
  } catch {
    // Content script may not be injected yet (e.g., extension just installed).
    // Inject it programmatically and retry.
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["content.js"],
    });
    await chrome.scripting.insertCSS({
      target: { tabId: tab.id },
      files: ["style.css"],
    });
    await chrome.tabs.sendMessage(tab.id, { action: "analyze" });
  }
});
