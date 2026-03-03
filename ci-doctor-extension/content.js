/**
 * CI Doctor — Content Script
 * Injected into GitHub pages. Extracts CI logs, calls the backend,
 * and renders the fix popup.
 */

const BACKEND_URL = "http://127.0.0.1:8080";

// ─── Platform detection ───────────────────────────────────────────────────────

/**
 * Returns "github" | "jenkins" | "unknown".
 * Jenkins can live on any domain so we check DOM markers + URL patterns.
 */
function detectPlatform() {
  const url = window.location.href;
  if (url.includes("github.com")) return "github";

  // Jenkins DOM markers
  const hasJenkinsDOM =
    !!document.querySelector("#jenkins, .jenkins-pane, #jenkins-home-link") ||
    document.title.toLowerCase().includes("jenkins");

  // Jenkins URL patterns: classic /job/…/console, Blue Ocean /blue/organizations/…/pipeline
  const path = window.location.pathname;
  const isJenkinsUrl =
    /\/job\/[^/]+\/\d+\//.test(path) ||
    path.includes("/console") ||
    path.includes("pipeline-console") ||
    path.includes("/blue/organizations/");

  if (hasJenkinsDOM || isJenkinsUrl) return "jenkins";
  return "unknown";
}

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

  const platform = detectPlatform();

  if (platform === "github") {
    // Must be on a job page, not just the run overview
    if (!window.location.pathname.includes("/job/")) {
      showPopup();
      setError("Please open a specific job first.\n\nOn this page click the failed job name (e.g. \"build\", \"test\") in the left sidebar — then click CI Doctor again.");
      return;
    }
  } else if (platform === "jenkins") {
    const path = window.location.pathname;
    const isOnBuildPage =
      path.includes("/console") ||
      path.includes("pipeline-console") ||
      // Blue Ocean: /blue/organizations/{controller}/{job}/detail/{job}/{build}/pipeline
      /\/blue\/organizations\/[^/]+\/[^/]+\/detail\/[^/]+\/\d+\//.test(path);
    if (!isOnBuildPage) {
      showPopup();
      setError("Please open the build page.\n\nClassic Jenkins: click \"Console Output\".\nBlue Ocean: open the failed pipeline run — then click CI Doctor again.");
      return;
    }
  }

  showPopup();
  setLoading();

  waitForLog(5000, platform)
    .then((log) => callBackend(log, updateLoadingMessage))
    .then((data) => renderResult(data, platform))
    .catch((err) => setError(err.message));
}

/** Tries GitHub API first (full log), then falls back to DOM extraction. */
async function waitForLog(timeout, platform = "github") {
  let mainLog = null;

  if (platform === "github") {
    // 1. GitHub API — full log, not limited by virtual scroll
    try {
      const apiLog = await fetchJobLogViaAPI();
      if (apiLog && apiLog.length > 50) {
        console.log(`[CI Doctor] Using API log (${apiLog.length} chars)`);
        mainLog = apiLog;
      } else {
        console.log("[CI Doctor] API returned empty/short log, falling back to DOM");
      }
    } catch (e) {
      console.log("[CI Doctor] API log fetch failed, falling back to DOM:", e.message);
    }
  }

  // 2. DOM polling fallback (GitHub) or primary (Jenkins)
  if (!mainLog) {
    mainLog = await pollDomForLog(timeout, platform);
  }

  // 3. For Jenkins: augment with build artifacts (test reports, error logs, etc.)
  if (platform === "jenkins") {
    try {
      const artifactText = await fetchJenkinsArtifactsText();
      if (artifactText) {
        console.log("[CI Doctor] Appending Jenkins artifacts to log");
        mainLog += artifactText;
      }
    } catch (e) {
      console.log("[CI Doctor] Artifact fetch failed (non-fatal):", e.message);
    }
  }

  return mainLog;
}

/** Polls the DOM until a log appears or timeout is reached. */
function pollDomForLog(timeout, platform) {
  const MIN_LOG_LENGTH = 80;
  const extractFn = platform === "jenkins" ? extractJenkinsLog : extractFailedLog;
  return new Promise((resolve, reject) => {
    const start = Date.now();
    function attempt() {
      const log = extractFn();
      if (log && log.length >= MIN_LOG_LENGTH) return resolve(log);
      if (Date.now() - start >= timeout) {
        if (log) return resolve(log);
        return reject(new Error(
          platform === "jenkins"
            ? "No console output found.\n\nMake sure you are on the \"Console Output\" page of a finished Jenkins build."
            : "No log content found on this page.\n\nTry clicking on a failed step to expand its full log, then retry."
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

  console.log(`[CI Doctor] Fetching logs for job ${jobId} in ${repoBase} (auth: ${!!headers.Authorization})`);
  const resp = await fetch(
    `https://api.github.com/repos/${repoBase}/actions/jobs/${jobId}/logs`,
    { headers, redirect: "follow" }
  );
  console.log(`[CI Doctor] Log API response: ${resp.status} url=${resp.url}`);
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

// ─── Jenkins log extraction ───────────────────────────────────────────────────

/**
 * Extracts the console log from a Jenkins build page.
 * Supports classic Jenkins and Blue Ocean pipeline views.
 */
function extractJenkinsLog() {
  const log = (...args) => console.log("[CI Doctor]", ...args);
  log("Jenkins extraction on:", window.location.href);

  // 1. Classic Jenkins: <pre id="out"> or <div id="out"><pre>
  const classicSelectors = [
    "pre#out",
    "#out pre",
    ".console-output",
    "pre.console-output",
  ];
  for (const sel of classicSelectors) {
    const el = document.querySelector(sel);
    if (el && el.textContent.length > 50) {
      log(`Classic Jenkins log via "${sel}" (${el.textContent.length} chars)`);
      return truncateLog(el.textContent);
    }
  }

  // 2. Blue Ocean pipeline view: collect all visible log text from failed steps
  // Blue Ocean renders logs inside elements with class names containing "log"
  const blueOceanContainerSelectors = [
    "[class*='LogConsole']",
    "[class*='log-body']",
    "[class*='log-content']",
    "[class*='step-log']",
    "[class*='pipeline-log']",
  ];
  for (const sel of blueOceanContainerSelectors) {
    const container = document.querySelector(sel);
    if (container && container.textContent.length > 50) {
      log(`Blue Ocean container via "${sel}" (${container.textContent.length} chars)`);
      return truncateLog(container.textContent);
    }
  }

  // Blue Ocean: individual log line spans (when logs are rendered line-by-line)
  const blueOceanLineSelectors = [
    ".log-body .log-text",
    "[class*='LogConsole'] span",
    ".pipeline-log-text",
    ".log-text",
  ];
  for (const sel of blueOceanLineSelectors) {
    const lines = document.querySelectorAll(sel);
    if (lines.length > 5) {
      log(`Blue Ocean lines via "${sel}" (${lines.length} lines)`);
      return truncateLog(Array.from(lines).map((l) => l.textContent).join("\n"));
    }
  }

  // 3. Any large <pre> block as last resort
  const pre = [...document.querySelectorAll("pre")].find((p) => p.textContent.length > 200);
  if (pre) {
    log(`Fallback <pre> (${pre.textContent.length} chars)`);
    return truncateLog(pre.textContent);
  }

  log("FAILED — Jenkins log not found. Pre elements:", [...document.querySelectorAll("pre")].map((e) => `${e.id || e.className}(${e.textContent.length})`).join(", "));
  return null;
}

/** Keeps beginning + end of long logs (like fetchJobLogViaAPI). */
function truncateLog(text) {
  if (text.length <= 12000) return text;
  return text.slice(0, 6000) + "\n...[truncated middle]...\n" + text.slice(-4000);
}

// ─── Jenkins artifact fetching ────────────────────────────────────────────────

/**
 * Fetches text content from Jenkins build artifacts (test reports, error logs, etc.).
 * Uses the browser's session cookies automatically — no extra auth needed.
 * Returns a formatted string with artifact contents, or null if nothing useful found.
 */
async function fetchJenkinsArtifactsText() {
  const origin = window.location.origin;
  const path = window.location.pathname;
  const log = (...args) => console.log("[CI Doctor]", ...args);
  let artifacts = [];

  // ── Blue Ocean REST API ──────────────────────────────────────────────────────
  // Pattern: /blue/organizations/{controller}/{job}/detail/{job}/{build}/...
  const blueMatch = path.match(/\/blue\/organizations\/([^/]+)\/([^/]+)\/detail\/[^/]+\/(\d+)/);
  if (blueMatch) {
    const [, controller, job, build] = blueMatch;
    try {
      const resp = await fetch(
        `${origin}/blue/rest/organizations/${controller}/pipelines/${job}/runs/${build}/artifacts/`
      );
      if (resp.ok) {
        const data = await resp.json();
        artifacts = data.map((a) => ({ name: a.name, url: `${origin}${a.url}`, size: a.size }));
        log(`Blue Ocean: ${artifacts.length} artifacts found`);
      }
    } catch (e) {
      log("Blue Ocean artifact API failed:", e.message);
    }
  }

  // ── Classic Jenkins API ──────────────────────────────────────────────────────
  // Pattern: /job/{path}/{build}/...  (path may contain nested /job/ segments)
  if (!artifacts.length) {
    const jobMatch = path.match(/^((?:\/job\/[^/]+)+)\/(\d+)/);
    if (jobMatch) {
      const [, jobPath, build] = jobMatch;
      try {
        const resp = await fetch(
          `${origin}${jobPath}/${build}/api/json?tree=artifacts[fileName,relativePath]`
        );
        if (resp.ok) {
          const data = await resp.json();
          artifacts = (data.artifacts || []).map((a) => ({
            name: a.fileName,
            url: `${origin}${jobPath}/${build}/artifact/${a.relativePath}`,
          }));
          log(`Classic Jenkins: ${artifacts.length} artifacts found`);
        }
      } catch (e) {
        log("Classic Jenkins artifact API failed:", e.message);
      }
    }
  }

  if (!artifacts.length) return null;

  // ── Filter: only small text-based artifacts likely to contain error details ──
  const relevant = artifacts.filter((a) => {
    const n = a.name.toLowerCase();
    return /\.(xml|json|log|txt)$/.test(n) && (!a.size || a.size < 200_000);
  });
  log(`Relevant artifacts: ${relevant.length} of ${artifacts.length}`);
  if (!relevant.length) return null;

  // ── Download up to 3 artifacts, total ≤ 15 KB added to the prompt ───────────
  const parts = [];
  let totalSent = 0;
  for (const artifact of relevant.slice(0, 3)) {
    if (totalSent >= 15_000) break;
    try {
      const resp = await fetch(artifact.url);
      if (!resp.ok) continue;
      const text = await resp.text();
      // Trim very large files: keep beginning + end
      const snippet =
        text.length > 5_000
          ? text.slice(0, 2_500) + "\n...\n" + text.slice(-2_000)
          : text;
      parts.push(`\n\n--- Artifact: ${artifact.name} ---\n${snippet}`);
      totalSent += snippet.length;
      log(`Downloaded artifact: ${artifact.name} (${text.length} chars, sent ${snippet.length})`);
    } catch (e) {
      log(`Failed to download artifact ${artifact.name}:`, e.message);
    }
  }

  return parts.length ? parts.join("") : null;
}

// ─── Backend call ────────────────────────────────────────────────────────────

// Module-level: provider used for the current analysis (set by callBackend)
let _activeProvider = "gemini";

async function callBackend(log, onStatus = () => {}) {
  const context = buildPageContext();

  // While the real backend isn't deployed yet, use the mock
  if (BACKEND_URL.includes("your-service")) {
    return mockGeminiResponse(log, context);
  }

  const stored = await chrome.storage.local.get([
    "github_pat", "llm_provider", "llm_model", "openai_api_key", "anthropic_api_key",
  ]);

  const provider = stored.llm_provider || "gemini";
  _activeProvider = provider;
  const llm_api_key =
    provider === "openai"    ? (stored.openai_api_key    || null) :
    provider === "anthropic" ? (stored.anthropic_api_key || null) : null;

  const resp = await fetch(`${BACKEND_URL}/analyze`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      log,
      context,
      github_pat:  stored.github_pat  || null,
      provider,
      model:       stored.llm_model   || null,
      llm_api_key,
    }),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`HTTP ${resp.status}: ${text}`);
  }

  // ── Read SSE stream ────────────────────────────────────────────────────────
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // SSE events are separated by "\n\n"
    const parts = buffer.split("\n\n");
    buffer = parts.pop(); // keep last incomplete chunk

    for (const part of parts) {
      if (!part.startsWith("data: ")) continue;
      let event;
      try { event = JSON.parse(part.slice(6)); } catch { continue; }

      if (event.status === "done") {
        if (event.provider) _activeProvider = event.provider;
        return event.result;
      }
      if (event.status === "error") throw new Error(event.message);
      if (event.message) onStatus(event.message);
    }
  }

  throw new Error("Stream ended without a result.");
}

/** Collects repo/run metadata from the current URL and page title. */
function buildPageContext() {
  const url = window.location.href;
  const platform = detectPlatform();

  if (platform === "jenkins") {
    // Blue Ocean: /blue/organizations/{controller}/{job}/detail/{job}/{build}/...
    const blueMatch = url.match(/\/blue\/organizations\/[^/]+\/([^/]+)\/detail\/[^/]+\/(\d+)/);
    if (blueMatch) {
      return { repo: `Jenkins (Blue Ocean): ${blueMatch[1]} #${blueMatch[2]}`, url, title: document.title };
    }
    // Classic Jenkins: /job/{folder}/job/{name}/{build}/console
    const jobMatch = url.match(/\/job\/([^/]+(?:\/job\/[^/]+)*)/);
    const jobName = jobMatch ? jobMatch[1].replace(/\/job\//g, "/") : "Jenkins Job";
    return { repo: `Jenkins: ${jobName}`, url, title: document.title };
  }

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
      <span class="tracefix-powered-by">⚡ Powered by AI</span>
    </div>
  `;
  document.body.appendChild(popup);

  document.getElementById("tracefix-close").addEventListener("click", () => popup.remove());
}

function setLoading() {
  document.getElementById("tracefix-body").innerHTML = `
    <div id="tracefix-loading">
      <div class="tracefix-spinner"></div>
      <p id="tracefix-loading-msg">Analyzing CI logs...</p>
    </div>
  `;
}

function updateLoadingMessage(msg) {
  const el = document.getElementById("tracefix-loading-msg");
  if (el) el.textContent = msg;
}

// Models available per provider (used by the quick-switch in the error state)
const _QS_MODELS = {
  gemini:    ["gemini-2.0-flash", "gemini-1.5-flash", "gemini-1.5-flash-8b", "gemini-2.5-flash"],
  openai:    ["gpt-4o-mini", "gpt-4o", "gpt-4-turbo"],
  anthropic: ["claude-haiku-4-5-20251001", "claude-sonnet-4-6", "claude-opus-4-6"],
};

async function populateQsModels(provider, selectedModel) {
  const sel = document.getElementById("qs-model");
  if (!sel) return;

  // Show static fallback immediately so the dropdown is never empty
  const fallback = _QS_MODELS[provider] || [];
  sel.innerHTML = fallback.map((m) => `<option value="${m}">${m}</option>`).join("");
  if (selectedModel && fallback.includes(selectedModel)) sel.value = selectedModel;

  // Fetch live model list from backend (fire-and-forget, updates dropdown when ready)
  try {
    const stored = await chrome.storage.local.get(["openai_api_key", "anthropic_api_key"]);
    const api_key = provider === "openai"    ? (stored.openai_api_key    || null)
                  : provider === "anthropic" ? (stored.anthropic_api_key || null)
                  : null;
    const resp = await fetch(`${BACKEND_URL}/models`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider, api_key }),
      signal: AbortSignal.timeout(5000),
    });
    if (resp.ok) {
      const data = await resp.json();
      if (Array.isArray(data.models) && data.models.length > 0) {
        const current = sel.value;  // preserve current selection if possible
        sel.innerHTML = data.models.map((m) => `<option value="${m}">${m}</option>`).join("");
        if (data.models.includes(current)) sel.value = current;
        else if (selectedModel && data.models.includes(selectedModel)) sel.value = selectedModel;
      }
    }
  } catch { /* keep fallback */ }
}

function setError(message) {
  const body = document.getElementById("tracefix-body");
  if (!body) return; // popup was closed before error arrived

  body.innerHTML = `
    <div id="tracefix-error">
      <div class="tracefix-error-icon">⚠️</div>
      <p>${message.replace(/\n/g, "<br>")}</p>
      <div class="tracefix-quick-switch">
        <div class="tracefix-qs-row">
          <span class="tracefix-qs-label">Provider</span>
          <select class="tracefix-qs-select" id="qs-provider">
            <option value="gemini">Google Gemini</option>
            <option value="openai">OpenAI</option>
            <option value="anthropic">Anthropic Claude</option>
          </select>
        </div>
        <div class="tracefix-qs-row">
          <span class="tracefix-qs-label">Model</span>
          <select class="tracefix-qs-select" id="qs-model"></select>
        </div>
      </div>
      <button class="tracefix-btn tracefix-btn-secondary" id="tracefix-retry">↺ Retry</button>
    </div>
  `;

  // Pre-populate from saved settings, then fetch live list
  chrome.storage.local.get(["llm_provider", "llm_model"], (data) => {
    const provider = data.llm_provider || "gemini";
    document.getElementById("qs-provider").value = provider;
    populateQsModels(provider, data.llm_model);
  });

  document.getElementById("qs-provider").addEventListener("change", (e) => {
    populateQsModels(e.target.value, null);
  });

  document.getElementById("tracefix-retry").addEventListener("click", async () => {
    const provider = document.getElementById("qs-provider")?.value;
    const model    = document.getElementById("qs-model")?.value;
    if (provider && model) {
      await chrome.storage.local.set({ llm_provider: provider, llm_model: model });
    }
    closePopup();
    runAnalysis();
  });
}

function renderResult(data, platform = "github") {
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
        <button class="tracefix-btn tracefix-btn-primary" id="tracefix-apply">${platform === "jenkins" ? "Copy Fix" : "Apply Fix"}</button>
        <button class="tracefix-btn tracefix-btn-secondary" id="tracefix-copy">Copy Diff</button>
      </div>
    </div>
  `;

  // Update "Powered by" label and confidence in footer
  const providerLabel = { gemini: "Gemini", openai: "OpenAI", anthropic: "Claude" }[_activeProvider] || "AI";
  footer.innerHTML = `<span class="tracefix-powered-by">⚡ Powered by ${providerLabel}</span>`;
  if (data.confidence) {
    footer.innerHTML += `<span class="tracefix-confidence">${data.confidence}% confidence</span>`;
  }

  // Apply fix button
  document.getElementById("tracefix-apply").addEventListener("click", async () => {
    const btn = document.getElementById("tracefix-apply");

    // Jenkins: copy added lines to clipboard (no direct API integration)
    if (platform === "jenkins") {
      const content = (data.fix_diff || [])
        .filter((l) => l.type === "added")
        .map((l) => l.code)
        .join("\n");
      await navigator.clipboard.writeText(content);
      btn.textContent = "Copied!";
      setTimeout(() => { btn.textContent = "Copy Fix"; }, 2000);
      return;
    }

    // GitHub: try direct API commit, fall back to opening editor
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
