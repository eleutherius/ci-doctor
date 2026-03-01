/**
 * CI Doctor — Content Script
 * Injected into GitHub pages. Extracts CI logs, calls the backend,
 * and renders the fix popup.
 */

const BACKEND_URL = "https://your-service.run.app"; // TODO: replace after Cloud Run deploy

// ─── Entry point ────────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message) => {
  if (message.action === "analyze") {
    runAnalysis();
  }
});

// ─── Auto-close on SPA navigation ───────────────────────────────────────────
// GitHub uses the History API — intercept pushState + listen to popstate.

function closePopup() {
  document.getElementById("tracefix-popup")?.remove();
}

const _origPushState = history.pushState.bind(history);
history.pushState = function (...args) {
  _origPushState(...args);
  closePopup();
};
window.addEventListener("popstate", closePopup);

function runAnalysis() {
  // Only one popup at a time
  if (document.getElementById("tracefix-popup")) return;

  showPopup();
  setLoading();

  const log = extractFailedLog();

  if (!log) {
    setError("Logs not found on this page.\n\nPossible reasons:\n• CI Doctor app is not connected or offline\n• No internet connection\n• No failed GitHub Actions steps on this page\n\nNavigate to a failed Actions run and try again.");
    return;
  }

  callBackend(log)
    .then((data) => renderResult(data))
    .catch((err) => setError(`Backend error: ${err.message}`));
}

// ─── Log extraction ──────────────────────────────────────────────────────────

/**
 * Tries several GitHub Actions DOM selectors to grab the failed step log text.
 * Returns null when nothing is found.
 */
function extractFailedLog() {
  // 1. New-style step log lines (data-testid based)
  const failedStep = document.querySelector('[data-testid="step-container"][aria-label*="failed"]')
    || document.querySelector('.job-step-container.failed');

  if (failedStep) {
    const lines = failedStep.querySelectorAll('.log-line-content, [data-testid="log-line-content"]');
    if (lines.length) {
      return Array.from(lines).map((l) => l.textContent).join("\n").trim();
    }
  }

  // 2. Fallback: grab all visible log lines that contain error signals
  const allLines = document.querySelectorAll('.log-line-content, .log-body__line, [data-testid="log-line-content"]');
  if (allLines.length) {
    const errorKeywords = /error|fail|exception|traceback|cannot|not found|exit code/i;
    const relevant = Array.from(allLines)
      .map((l) => l.textContent.trim())
      .filter((t) => t && errorKeywords.test(t));

    if (relevant.length) {
      return relevant.slice(-80).join("\n"); // last 80 error lines
    }

    // Last resort: return last 100 lines of whatever is there
    const all = Array.from(allLines).map((l) => l.textContent.trim()).filter(Boolean);
    return all.slice(-100).join("\n");
  }

  // 3. Pre-formatted log blocks (older GitHub UI)
  const pre = document.querySelector('pre.log-output, pre[class*="log"]');
  if (pre) return pre.textContent.slice(-8000);

  return null;
}

// ─── Backend call ────────────────────────────────────────────────────────────

async function callBackend(log) {
  const context = buildPageContext();

  // While the real backend isn't deployed yet, use the mock
  if (BACKEND_URL.includes("your-service")) {
    return mockGeminiResponse(log, context);
  }

  const resp = await fetch(`${BACKEND_URL}/analyze`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ log, context }),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`HTTP ${resp.status}: ${text}`);
  }

  return resp.json();
}

/** Collects repo/run metadata from the current URL and page title. */
function buildPageContext() {
  const url = window.location.href;
  const match = url.match(/github\.com\/([^/]+\/[^/]+)/);
  return {
    repo: match ? match[1] : "unknown",
    url,
    title: document.title,
  };
}

// ─── Mock response (until real backend exists) ───────────────────────────────

function mockGeminiResponse(log, _context) {
  const isNode = /npm|node|require|module/i.test(log);
  const isPython = /pip|python|import|traceback/i.test(log);
  const isDocker = /docker|dockerfile|layer/i.test(log);

  const scenarios = {
    node: {
      error_type: "Dependency Resolution Error",
      summary: "npm cannot resolve a peer dependency conflict. The lock-file references an incompatible version combination.",
      file: "package.json",
      fix_diff: [
        { type: "context", code: '  "dependencies": {' },
        { type: "removed", code: '    "react": "^17.0.2",' },
        { type: "added",   code: '    "react": "^18.2.0",' },
        { type: "removed", code: '    "react-dom": "^17.0.2"' },
        { type: "added",   code: '    "react-dom": "^18.2.0"' },
        { type: "context", code: "  }" },
      ],
      explanation: "Bumping react and react-dom to ^18.2.0 resolves the peer dependency conflict reported by npm. Run `npm install` locally to regenerate the lock-file.",
      confidence: 87,
    },
    python: {
      error_type: "ModuleNotFoundError",
      summary: "A required Python package is missing from the environment. The package is likely not listed in requirements.txt.",
      file: "requirements.txt",
      fix_diff: [
        { type: "context", code: "fastapi==0.110.0" },
        { type: "context", code: "uvicorn==0.29.0" },
        { type: "added",   code: "google-cloud-aiplatform==1.47.0" },
        { type: "added",   code: "vertexai==1.47.0" },
      ],
      explanation: "Adding the missing package to requirements.txt will make it available during the CI install step.",
      confidence: 91,
    },
    docker: {
      error_type: "Docker Build Failure",
      summary: "The Docker build fails because a base image layer cannot be pulled or a COPY instruction references a missing file.",
      file: "Dockerfile",
      fix_diff: [
        { type: "removed", code: "FROM node:16-alpine" },
        { type: "added",   code: "FROM node:20-alpine" },
        { type: "context", code: "WORKDIR /app" },
        { type: "context", code: "COPY package*.json ./" },
      ],
      explanation: "The node:16 image is deprecated on this registry. Upgrading to node:20-alpine resolves the pull failure.",
      confidence: 78,
    },
    default: {
      error_type: "CI Pipeline Failure",
      summary: "The CI job exited with a non-zero status. The root cause appears to be a missing environment variable or misconfigured step.",
      file: ".github/workflows/ci.yml",
      fix_diff: [
        { type: "context", code: "    - name: Run tests" },
        { type: "context", code: "      run: |" },
        { type: "removed", code: "        npm test" },
        { type: "added",   code: "        npm ci && npm test" },
      ],
      explanation: "Using `npm ci` instead of relying on a cached install ensures a clean, reproducible environment on every run.",
      confidence: 72,
    },
  };

  const scenario = isNode ? scenarios.node : isPython ? scenarios.python : isDocker ? scenarios.docker : scenarios.default;

  return new Promise((resolve) => setTimeout(() => resolve(scenario), 1800));
}

// ─── DOM helpers ─────────────────────────────────────────────────────────────

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
      <span class="tracefix-powered-by">⚡ Powered by Gemini</span>
    </div>
  `;
  document.body.appendChild(popup);

  document.getElementById("tracefix-close").addEventListener("click", () => popup.remove());
}

function setLoading() {
  document.getElementById("tracefix-body").innerHTML = `
    <div id="tracefix-loading">
      <div class="tracefix-spinner"></div>
      <p>Analyzing CI logs with Gemini...</p>
    </div>
  `;
}

function setError(message) {
  document.getElementById("tracefix-body").innerHTML = `
    <div id="tracefix-error">
      <div class="tracefix-error-icon">⚠️</div>
      <p>${message.replace(/\n/g, "<br>")}</p>
      <button class="tracefix-btn tracefix-btn-secondary" id="tracefix-retry">↺ Retry</button>
    </div>
  `;
  document.getElementById("tracefix-retry").addEventListener("click", () => {
    closePopup();
    runAnalysis();
  });
}

function renderResult(data) {
  const body = document.getElementById("tracefix-body");
  const footer = document.getElementById("tracefix-footer");

  // Build diff HTML
  const diffLines = (data.fix_diff || []).map((line) => {
    const typeClass = line.type === "removed" ? "removed" : line.type === "added" ? "added" : "context";
    const sign = line.type === "removed" ? "−" : line.type === "added" ? "+" : " ";
    const escapedCode = line.code
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
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

  // Confidence badge in footer
  if (data.confidence) {
    footer.innerHTML += `<span class="tracefix-confidence">${data.confidence}% confidence</span>`;
  }

  // Apply fix → navigate to GitHub edit page
  document.getElementById("tracefix-apply").addEventListener("click", () => {
    const editUrl = buildEditUrl(data.file);
    if (editUrl) {
      window.open(editUrl, "_blank");
    } else {
      alert("Could not determine the edit URL. Please open the file manually.");
    }
  });

  // Copy diff to clipboard
  document.getElementById("tracefix-copy").addEventListener("click", () => {
    const diffText = (data.fix_diff || [])
      .map((l) => `${l.type === "removed" ? "-" : l.type === "added" ? "+" : " "} ${l.code}`)
      .join("\n");
    navigator.clipboard.writeText(diffText).then(() => {
      const btn = document.getElementById("tracefix-copy");
      btn.textContent = "Copied!";
      setTimeout(() => { btn.textContent = "Copy Diff"; }, 2000);
    });
  });
}

/** Builds the GitHub "edit file" URL for the given file path relative to repo root. */
function buildEditUrl(filePath) {
  // URL pattern: /owner/repo/edit/branch/path/to/file
  const match = window.location.pathname.match(/^\/([^/]+\/[^/]+)/);
  if (!match) return null;
  const repoBase = match[1];
  // Try to detect branch from URL
  const branchMatch = window.location.pathname.match(/\/tree\/([^/]+)/);
  const branch = branchMatch ? branchMatch[1] : "main";
  return `https://github.com/${repoBase}/edit/${branch}/${filePath}`;
}

function escapeHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
