/**
 * CI Doctor — Content Script
 *
 * Receives a screenshot from the background worker, sends it to the backend,
 * and renders the analysis popup.
 */

const BACKEND_URL = "http://127.0.0.1:8080";

// ─── Message listener ─────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message) => {
  if (message.action === "ping") return true; // health check for background.js

  if (message.action === "analyze") {
    runAnalysis(message.screenshot, message.url, message.title);
  }
});

// ─── Auto-close on SPA navigation ────────────────────────────────────────────

function closePopup() {
  document.getElementById("tracefix-popup")?.remove();
}

const _origPushState = history.pushState.bind(history);
history.pushState = function (...args) {
  _origPushState(...args);
  closePopup();
};
window.addEventListener("popstate", closePopup);

// ─── Main flow ────────────────────────────────────────────────────────────────

async function runAnalysis(screenshotDataUrl, url, title) {
  if (document.getElementById("tracefix-popup")) return;

  showPopup();
  setLoading("Sending screenshot to Vertex AI...");

  try {
    const result = await callBackend(screenshotDataUrl, url, title);
    renderResult(result);
  } catch (err) {
    setError(err.message);
  }
}

// ─── Backend call ─────────────────────────────────────────────────────────────

async function callBackend(dataUrl, url, title) {
  const { github_pat } = await chrome.storage.local.get("github_pat");

  // Strip "data:image/jpeg;base64," prefix
  const [header, image] = dataUrl.split(",");
  const mime_type = header.match(/:(.*?);/)?.[1] || "image/jpeg";

  const resp = await fetch(`${BACKEND_URL}/analyze`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      image,
      mime_type,
      context: { url, title },
      github_pat: github_pat || null,
    }),
  });

  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status}: ${await resp.text()}`);
  }

  // Read SSE stream
  const reader  = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const parts = buffer.split("\n\n");
    buffer = parts.pop();

    for (const part of parts) {
      if (!part.startsWith("data: ")) continue;
      let event;
      try { event = JSON.parse(part.slice(6)); } catch { continue; }

      if (event.status === "done")  return event.result;
      if (event.status === "error") throw new Error(event.message);
      if (event.message)            updateLoadingMessage(event.message);
    }
  }

  throw new Error("Stream ended without a result.");
}

// ─── DOM helpers ──────────────────────────────────────────────────────────────

function showPopup() {
  const popup = document.createElement("div");
  popup.id = "tracefix-popup";
  popup.innerHTML = `
    <div id="tracefix-header">
      <div id="tracefix-header-left">
        <div id="tracefix-logo">+</div>
        <span id="tracefix-title">CI Doctor</span>
        <span id="tracefix-badge">AI</span>
      </div>
      <button id="tracefix-close" title="Close">✕</button>
    </div>
    <div id="tracefix-body"></div>
    <div id="tracefix-footer">
      <span class="tracefix-powered-by">⚡ Powered by Vertex AI</span>
    </div>
  `;
  document.body.appendChild(popup);
  document.getElementById("tracefix-close").addEventListener("click", () => popup.remove());
}

function setLoading(msg = "Analyzing...") {
  document.getElementById("tracefix-body").innerHTML = `
    <div id="tracefix-loading">
      <div class="tracefix-spinner"></div>
      <p id="tracefix-loading-msg">${msg}</p>
    </div>
  `;
}

function updateLoadingMessage(msg) {
  const el = document.getElementById("tracefix-loading-msg");
  if (el) el.textContent = msg;
}

function setError(message) {
  const body = document.getElementById("tracefix-body");
  if (!body) return;

  body.innerHTML = `
    <div id="tracefix-error">
      <div class="tracefix-error-icon">⚠️</div>
      <p>${message.replace(/\n/g, "<br>")}</p>
      <button class="tracefix-btn tracefix-btn-secondary" id="tracefix-retry">↺ Retry</button>
    </div>
  `;

  document.getElementById("tracefix-retry").addEventListener("click", () => {
    closePopup();
  });
}

function renderResult(data) {
  const body   = document.getElementById("tracefix-body");
  const footer = document.getElementById("tracefix-footer");

  const diffLines = (data.fix_diff || []).map((line) => {
    const typeClass   = line.type === "removed" ? "removed" : line.type === "added" ? "added" : "context";
    const sign        = line.type === "removed" ? "−" : line.type === "added" ? "+" : " ";
    const escapedCode = escapeHtml(line.code);
    return `
      <div class="tracefix-diff-line ${typeClass}">
        <span class="tracefix-diff-sign">${sign}</span>
        <span class="tracefix-diff-code">${escapedCode}</span>
      </div>`;
  }).join("");

  body.innerHTML = `
    <div id="tracefix-result">
      <div class="tracefix-section">
        <span class="tracefix-section-label">Error detected</span>
        <span class="tracefix-error-type">✗ ${escapeHtml(data.error_type)}</span>
      </div>

      <div class="tracefix-section">
        <span class="tracefix-section-label">Summary</span>
        <div class="tracefix-summary">${escapeHtml(data.summary)}</div>
      </div>

      <div class="tracefix-divider"></div>

      <div class="tracefix-section">
        <div class="tracefix-fix-header">
          <span class="tracefix-section-label">Proposed fix</span>
          <span class="tracefix-file-badge">📄 ${escapeHtml(data.file)}</span>
        </div>
        <div class="tracefix-diff">${diffLines}</div>
      </div>

      <div class="tracefix-explanation">${escapeHtml(data.explanation)}</div>

      <div class="tracefix-actions">
        <button class="tracefix-btn tracefix-btn-primary" id="tracefix-apply">Apply Fix</button>
        <button class="tracefix-btn tracefix-btn-secondary" id="tracefix-copy">Copy Diff</button>
      </div>
    </div>
  `;

  if (data.confidence) {
    footer.innerHTML = `
      <span class="tracefix-powered-by">⚡ Vertex AI</span>
      <span class="tracefix-confidence">${data.confidence}% confidence</span>
    `;
  }

  // Apply fix button
  document.getElementById("tracefix-apply").addEventListener("click", async () => {
    const btn = document.getElementById("tracefix-apply");
    btn.textContent = "Applying...";
    btn.disabled = true;
    try {
      const { github_pat: token } = await chrome.storage.local.get("github_pat");
      if (token) {
        const result = await applyFixViaAPI(data.file, data.fix_diff, token);
        if (result.success) {
          btn.textContent = "✓ Committed!";
          btn.style.background = "#238636";
          setTimeout(() => {
            btn.textContent = "Apply Fix";
            btn.style.background = "";
            btn.disabled = false;
          }, 3000);
          return;
        }
        setError(`Could not auto-commit: ${result.error}\n\nOpening GitHub editor instead.`);
      }
      const { url, isNew } = await buildEditUrl(data.file, token);
      if (!url) { alert("Could not determine the edit URL."); return; }
      if (isNew) {
        const content = (data.fix_diff || []).filter(l => l.type === "added").map(l => l.code).join("\n");
        await navigator.clipboard.writeText(content);
        btn.textContent = "Copied! Paste in editor";
        setTimeout(() => { btn.textContent = "Apply Fix"; btn.disabled = false; }, 3000);
      }
      window.open(url, "_blank");
    } catch {
      btn.textContent = "Apply Fix";
      btn.disabled = false;
    }
  });

  // Copy diff
  document.getElementById("tracefix-copy").addEventListener("click", () => {
    const diffText = (data.fix_diff || [])
      .map(l => `${l.type === "removed" ? "-" : l.type === "added" ? "+" : " "} ${l.code}`)
      .join("\n");
    navigator.clipboard.writeText(diffText).then(() => {
      const btn = document.getElementById("tracefix-copy");
      btn.textContent = "Copied!";
      setTimeout(() => { btn.textContent = "Copy Diff"; }, 2000);
    });
  });
}

// ─── GitHub API helpers ───────────────────────────────────────────────────────

async function applyFixViaAPI(filePath, fixDiff, token) {
  const match = window.location.pathname.match(/^\/([^/]+\/[^/]+)/);
  if (!match) return { success: false, error: "Could not parse repository from URL." };
  const repoBase = match[1];
  const headers  = { Authorization: `token ${token}`, "Content-Type": "application/json" };

  let branch = "main";
  try {
    const r = await fetch(`https://api.github.com/repos/${repoBase}`, { headers });
    if (r.ok) branch = (await r.json()).default_branch || "main";
  } catch { /* use "main" */ }

  let sha = null;
  let newContent = "";
  const fileResp = await fetch(
    `https://api.github.com/repos/${repoBase}/contents/${filePath}?ref=${branch}`,
    { headers }
  );

  if (fileResp.ok) {
    const fileData = await fileResp.json();
    sha = fileData.sha;
    const currentContent = new TextDecoder().decode(
      Uint8Array.from(atob(fileData.content.replace(/\n/g, "")), c => c.charCodeAt(0))
    );
    newContent = applyDiff(currentContent, fixDiff);
    if (!newContent) return { success: false, error: "Could not locate the diff context in the file." };
  } else if (fileResp.status === 404) {
    newContent = fixDiff.filter(l => l.type === "added").map(l => l.code).join("\n") + "\n";
  } else {
    return { success: false, error: `GitHub API error ${fileResp.status}` };
  }

  const body = {
    message: "fix: apply CI Doctor suggestion\n\nAuto-committed by CI Doctor extension.",
    content: btoa(Array.from(new TextEncoder().encode(newContent), b => String.fromCharCode(b)).join("")),
    branch,
  };
  if (sha) body.sha = sha;

  const commitResp = await fetch(
    `https://api.github.com/repos/${repoBase}/contents/${filePath}`,
    { method: "PUT", headers, body: JSON.stringify(body) }
  );

  if (commitResp.ok) return { success: true };
  const err = await commitResp.json();
  return { success: false, error: err.message || `HTTP ${commitResp.status}` };
}

function applyDiff(content, fixDiff) {
  const lines        = content.split("\n");
  const searchLines  = fixDiff.filter(l => l.type !== "added").map(l => l.code);
  const replaceLines = fixDiff.filter(l => l.type !== "removed").map(l => l.code);
  if (!searchLines.length) return null;
  for (let i = 0; i <= lines.length - searchLines.length; i++) {
    if (searchLines.every((s, j) => lines[i + j].trim() === s.trim())) {
      lines.splice(i, searchLines.length, ...replaceLines);
      return lines.join("\n");
    }
  }
  return null;
}

async function buildEditUrl(filePath) {
  const match = window.location.pathname.match(/^\/([^/]+\/[^/]+)/);
  if (!match) return { url: null, isNew: false };
  const repoBase = match[1];

  let branch = "main";
  try {
    const resp = await fetch(`https://api.github.com/repos/${repoBase}`);
    if (resp.ok) branch = (await resp.json()).default_branch || "main";
  } catch { /* use "main" */ }

  try {
    const resp = await fetch(`https://api.github.com/repos/${repoBase}/contents/${filePath}?ref=${branch}`);
    if (resp.ok) return { url: `https://github.com/${repoBase}/edit/${branch}/${filePath}`, isNew: false };
  } catch { /* fall through */ }

  const dir  = filePath.includes("/") ? filePath.substring(0, filePath.lastIndexOf("/") + 1) : "";
  const name = filePath.includes("/") ? filePath.substring(filePath.lastIndexOf("/") + 1) : filePath;
  return { url: `https://github.com/${repoBase}/new/${branch}/${dir}?filename=${name}`, isNew: true };
}

function escapeHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
