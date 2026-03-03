/**
 * CI Doctor — Content Script
 * Injected into GitHub pages. Extracts CI logs, calls the backend,
 * and renders the fix popup.
 */

const BACKEND_URL = "http://127.0.0.1:8080";

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

  // Must be on a job page, not just the run overview
  if (!window.location.pathname.includes("/job/")) {
    showPopup();
    setError("Please open a specific job first.\n\nOn this page click the failed job name (e.g. \"build\", \"test\") in the left sidebar — then click CI Doctor again.");
    return;
  }

  showPopup();
  setLoading();

  // GitHub loads logs asynchronously — wait up to 5 s for content to appear
  waitForLog(5000)
    .then((log) => callBackend(log))
    .then((data) => renderResult(data))
    .catch((err) => setError(err.message));
}

/** Tries GitHub API first (full log), then falls back to DOM extraction. */
async function waitForLog(timeout) {
  // 1. GitHub API — full log, not limited by virtual scroll
  try {
    const apiLog = await fetchJobLogViaAPI();
    if (apiLog && apiLog.length > 50) return apiLog;
  } catch (e) {
    console.log("[CI Doctor] API log fetch failed, falling back to DOM:", e.message);
  }

  // 2. DOM polling fallback
  const MIN_LOG_LENGTH = 80;
  return new Promise((resolve, reject) => {
    const start = Date.now();
    function attempt() {
      const log = extractFailedLog();
      if (log && log.length >= MIN_LOG_LENGTH) return resolve(log);
      if (Date.now() - start >= timeout) {
        if (log) return resolve(log);
        return reject(new Error(
          "No log content found on this page.\n\n" +
          "Try clicking on a failed step to expand its full log, then retry."
        ));
      }
      setTimeout(attempt, 500);
    }
    attempt();
  });
}

/** Fetches the complete job log from GitHub API (bypasses virtual scroll). */
async function fetchJobLogViaAPI() {
  const match = window.location.pathname.match(
    /\/([^/]+\/[^/]+)\/actions\/runs\/\d+\/job\/(\d+)/
  );
  if (!match) return null;
  const [, repoBase, jobId] = match;

  const { github_pat: token } = await chrome.storage.local.get("github_pat");
  const headers = token ? { Authorization: `token ${token}` } : {};

  const resp = await fetch(
    `https://api.github.com/repos/${repoBase}/actions/jobs/${jobId}/logs`,
    { headers, redirect: "follow" }
  );
  if (!resp.ok) return null;

  const text = await resp.text();
  // Strip GitHub's timestamp prefix (2024-01-01T00:00:00.0000000Z ) from each line
  const clean = text.replace(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z /gm, "");
  if (clean.length <= 12000) return clean;
  // For long logs: send the first half (hook errors) + last part (final error)
  return clean.slice(0, 6000) + "\n...[truncated middle]...\n" + clean.slice(-4000);
}

// ─── Log extraction ──────────────────────────────────────────────────────────

/**
 * Tries several GitHub Actions DOM selectors to grab the failed step log text.
 * Returns null when nothing is found.
 */
function extractFailedLog() {
  const log = (...args) => console.log('[CI Doctor]', ...args);

  log('Starting extraction on:', window.location.href);

  // 1. New-style step containers (try multiple aria-label variants)
  const failedStepSelectors = [
    '[data-testid="step-container"][aria-label*="failed"]',
    '[data-testid="step-container"][aria-label*="failure"]',
    '[data-testid="step-container"][data-step-state="failure"]',
    '.job-step-container.failed',
    '.step-container.failed',
    '[data-component="step-log"]',
  ];
  let failedStep = null;
  for (const sel of failedStepSelectors) {
    failedStep = document.querySelector(sel);
    if (failedStep) { log('Found failedStep via:', sel); break; }
  }

  if (failedStep) {
    const lineSelectors = '.log-line-content, [data-testid="log-line-content"], .log-line, span[data-line]';
    const lines = failedStep.querySelectorAll(lineSelectors);
    log('Lines in failedStep:', lines.length);
    if (lines.length) {
      return Array.from(lines).map((l) => l.textContent).join("\n").trim();
    }
    // Fallback: just grab all text from the failed step container
    const text = failedStep.innerText.trim();
    log('failedStep.innerText length:', text.length);
    if (text.length > 10) return text.slice(-8000);
  }

  // 2. All log lines on the page
  const lineSelectors = [
    '.log-line-content',
    '.log-body__line',
    '[data-testid="log-line-content"]',
    '.log-line',
    'span[data-line]',
    '[class*="logLine"]',
    '[class*="log-line"]',
  ];
  for (const sel of lineSelectors) {
    const allLines = document.querySelectorAll(sel);
    if (allLines.length) {
      log('Found', allLines.length, 'lines via:', sel);
      const errorKeywords = /error|fail|exception|traceback|cannot|not found|exit code/i;
      const relevant = Array.from(allLines)
        .map((l) => l.textContent.trim())
        .filter((t) => t && errorKeywords.test(t));
      if (relevant.length) return relevant.slice(-80).join("\n");
      const all = Array.from(allLines).map((l) => l.textContent.trim()).filter(Boolean);
      return all.slice(-100).join("\n");
    }
  }

  // 3. Pre/code blocks
  const preSelectors = [
    'pre.log-output',
    'pre[class*="log"]',
    'pre[class*="Log"]',
    'code[class*="log"]',
    'pre',
  ];
  for (const sel of preSelectors) {
    const el = document.querySelector(sel);
    if (el && el.textContent.length > 50) {
      log('Found pre/code via:', sel, 'length:', el.textContent.length);
      return el.textContent.slice(-8000);
    }
  }

  // 4. Any container with "log" in aria-label
  const logContainer = document.querySelector('[aria-label*="log" i], [aria-label*="output" i]');
  if (logContainer) {
    const text = logContainer.innerText.trim();
    log('Found logContainer via aria-label, length:', text.length);
    if (text.length > 10) return text.slice(-8000);
  }

  log('FAILED — no log content found. DOM snapshot:');
  log('All data-testid values:', [...document.querySelectorAll('[data-testid]')].map(e => e.dataset.testid).join(', '));
  log('Classes with "log":', [...document.querySelectorAll('[class*="log"]')].slice(0, 10).map(e => e.className).join(' | '));

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

  // Apply fix — directly via GitHub API if token exists, otherwise open editor
  document.getElementById("tracefix-apply").addEventListener("click", async () => {
    const btn = document.getElementById("tracefix-apply");
    btn.textContent = "Applying...";
    btn.disabled = true;
    try {
      const { token } = await chrome.storage.local.get("github_pat");
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
        } else {
          // API failed — fall back to editor and show error
          setError(`Could not auto-commit: ${result.error}\n\nOpening GitHub editor instead.`);
        }
      }
      // No token or API failed — fall back to opening GitHub editor
      const { url, isNew } = await buildEditUrl(data.file, token);
      if (!url) {
        alert("Could not determine the edit URL. Please open the file manually.");
        return;
      }
      if (isNew) {
        const content = (data.fix_diff || [])
          .filter((l) => l.type === "added")
          .map((l) => l.code)
          .join("\n");
        await navigator.clipboard.writeText(content);
        btn.textContent = "Copied! Paste in editor";
        setTimeout(() => { btn.textContent = "Apply Fix"; btn.disabled = false; }, 3000);
      }
      window.open(url, "_blank");
    } catch (e) {
      btn.textContent = "Apply Fix";
      btn.disabled = false;
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

// ─── GitHub API: apply fix directly ──────────────────────────────────────────

async function applyFixViaAPI(filePath, fixDiff, token) {
  const match = window.location.pathname.match(/^\/([^/]+\/[^/]+)/);
  if (!match) return { success: false, error: "Could not parse repository from URL." };
  const repoBase = match[1];
  const headers = { Authorization: `token ${token}`, "Content-Type": "application/json" };

  // Get default branch
  let branch = "main";
  try {
    const r = await fetch(`https://api.github.com/repos/${repoBase}`, { headers });
    if (r.ok) branch = (await r.json()).default_branch || "main";
  } catch (e) { /* use "main" */ }

  // Try to fetch existing file
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
      Uint8Array.from(atob(fileData.content.replace(/\n/g, "")), (c) => c.charCodeAt(0))
    );
    newContent = applyDiff(currentContent, fixDiff);
    if (!newContent) {
      return { success: false, error: "Could not locate the diff context in the file." };
    }
  } else if (fileResp.status === 404) {
    // New file — use only the added lines
    newContent = fixDiff.filter((l) => l.type === "added").map((l) => l.code).join("\n") + "\n";
  } else {
    return { success: false, error: `GitHub API error ${fileResp.status}` };
  }

  // Commit
  const body = {
    message: `fix: apply CI Doctor suggestion\n\nAuto-committed by CI Doctor extension.`,
    content: btoa(
      Array.from(new TextEncoder().encode(newContent), (b) => String.fromCharCode(b)).join("")
    ),
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

/** Applies fix_diff to fileContent. Returns new content string or null if context not found. */
function applyDiff(content, fixDiff) {
  const lines = content.split("\n");
  const searchLines = fixDiff.filter((l) => l.type !== "added").map((l) => l.code);
  const replaceLines = fixDiff.filter((l) => l.type !== "removed").map((l) => l.code);

  if (!searchLines.length) return null; // nothing to search for

  for (let i = 0; i <= lines.length - searchLines.length; i++) {
    const match = searchLines.every((s, j) => lines[i + j].trim() === s.trim());
    if (match) {
      lines.splice(i, searchLines.length, ...replaceLines);
      return lines.join("\n");
    }
  }
  return null;
}

/** Builds the GitHub edit or create URL for the given file path.
 *  Returns { url, isNew } where isNew=true means the file doesn't exist yet. */
async function buildEditUrl(filePath) {
  const match = window.location.pathname.match(/^\/([^/]+\/[^/]+)/);
  if (!match) return { url: null, isNew: false };
  const repoBase = match[1];

  // Get the default branch from GitHub API
  let branch = "main";
  try {
    const resp = await fetch(`https://api.github.com/repos/${repoBase}`);
    if (resp.ok) {
      const info = await resp.json();
      branch = info.default_branch || "main";
    }
  } catch (e) { /* use "main" as fallback */ }

  // Check if the file already exists
  try {
    const resp = await fetch(`https://api.github.com/repos/${repoBase}/contents/${filePath}?ref=${branch}`);
    if (resp.ok) {
      return { url: `https://github.com/${repoBase}/edit/${branch}/${filePath}`, isNew: false };
    }
  } catch (e) { /* fall through to create */ }

  // File doesn't exist — open the "create new file" page
  const dir = filePath.includes("/") ? filePath.substring(0, filePath.lastIndexOf("/") + 1) : "";
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
