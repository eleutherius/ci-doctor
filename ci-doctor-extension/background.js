/**
 * TraceFix — Background Service Worker (Manifest V3)
 *
 * Listens for a click on the extension icon and tells the active tab's
 * content script to run the analysis.
 */

chrome.action.onClicked.addListener(async (tab) => {
  // Skip internal browser pages where injection is impossible
  if (!tab.url || tab.url.startsWith("chrome://") || tab.url.startsWith("chrome-extension://") || tab.url.startsWith("about:")) {
    console.warn("[CI Doctor] Cannot run on this page.");
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
