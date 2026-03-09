const TOKEN_KEY = "github_pat";
const TOKEN_URL = "https://github.com/settings/tokens/new?scopes=repo,workflow&description=CI+Doctor";

document.getElementById("token-link").href = TOKEN_URL;

// Load saved token
chrome.storage.local.get(TOKEN_KEY, (data) => {
  if (data[TOKEN_KEY]) {
    document.getElementById("pat").value = data[TOKEN_KEY];
    showStatus("Token saved", "ok");
  }
});

// Save
document.getElementById("save").addEventListener("click", () => {
  const token = document.getElementById("pat").value.trim();

  if (token && !token.startsWith("ghp_") && !token.startsWith("github_pat_")) {
    showStatus("Doesn't look like a valid GitHub token", "err");
    return;
  }

  if (token) {
    chrome.storage.local.set({ [TOKEN_KEY]: token }, () => showStatus("Saved!", "ok"));
  } else {
    showStatus("No token entered", "err");
  }
});

// Clear
document.getElementById("clear").addEventListener("click", () => {
  document.getElementById("pat").value = "";
  chrome.storage.local.remove(TOKEN_KEY, () => showStatus("Cleared", "ok"));
});

function showStatus(msg, type) {
  const el = document.getElementById("status");
  el.textContent = msg;
  el.className = type === "ok" ? "status-ok" : "status-err";
}
