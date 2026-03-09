/**
 * CI Doctor — Background Service Worker (Manifest V3)
 *
 * On icon click: captures a screenshot of the active tab,
 * injects the content script if needed, then forwards the image.
 */

chrome.action.onClicked.addListener(async (tab) => {
  if (
    !tab.url ||
    tab.url.startsWith("chrome://") ||
    tab.url.startsWith("chrome-extension://") ||
    tab.url.startsWith("about:")
  ) {
    console.warn("[CI Doctor] Cannot run on this page.");
    return;
  }

  try {
    // Capture screenshot of the visible area
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
      format: "jpeg",
      quality: 85,
    });

    // Ensure content script is injected
    try {
      await chrome.tabs.sendMessage(tab.id, { action: "ping" });
    } catch {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
      await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ["style.css"] });
    }

    // Send screenshot + page context to content script
    await chrome.tabs.sendMessage(tab.id, {
      action: "analyze",
      screenshot: dataUrl,          // "data:image/jpeg;base64,..."
      url: tab.url,
      title: tab.title,
    });
  } catch (err) {
    console.error("[CI Doctor] Error:", err);
  }
});
