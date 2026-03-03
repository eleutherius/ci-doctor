const TOKEN_KEY      = "github_pat";
const PROVIDER_KEY   = "llm_provider";
const MODEL_KEY      = "llm_model";
const OAI_KEY        = "openai_api_key";
const ANT_KEY        = "anthropic_api_key";
const TOKEN_URL      = "https://github.com/settings/tokens/new?scopes=repo,workflow&description=CI+Doctor";
const BACKEND_URL    = "http://127.0.0.1:8080";

const PROVIDERS = {
  gemini: {
    label: "Google Gemini",
    keyRequired: false,
    keyPlaceholder: "",
    keyHint: "Uses the GEMINI_API_KEY set on the backend server.",
    // hint info per model (shown when model is in this list)
    modelHints: {
      "gemini-2.0-flash":    { quota: "1 500 req/day", tier: "high", note: "Best balance of quality and quota." },
      "gemini-1.5-flash":    { quota: "1 500 req/day", tier: "high", note: "Reliable, high quota." },
      "gemini-1.5-flash-8b": { quota: "1 500 req/day", tier: "high", note: "Fastest response, lighter model." },
      "gemini-2.5-flash":    { quota: "20 req/day",    tier: "low",  note: "Highest quality, limited free quota." },
    },
  },
  openai: {
    label: "OpenAI",
    keyRequired: true,
    keyPlaceholder: "sk-...",
    keyHint: 'Your OpenAI API key. Get one at <a href="https://platform.openai.com/api-keys" target="_blank">platform.openai.com</a>.',
    modelHints: {
      "gpt-4o-mini": { note: "Fast & cheap. Best for most use cases." },
      "gpt-4o":      { note: "Most capable GPT-4 model." },
    },
  },
  anthropic: {
    label: "Anthropic Claude",
    keyRequired: true,
    keyPlaceholder: "sk-ant-...",
    keyHint: 'Your Anthropic API key. Get one at <a href="https://console.anthropic.com/" target="_blank">console.anthropic.com</a>.',
    modelHints: {
      "claude-haiku-4-5-20251001": { note: "Fastest & cheapest Claude model." },
      "claude-sonnet-4-6":         { note: "Best balance of quality and cost." },
      "claude-opus-4-6":           { note: "Most capable Claude model." },
    },
  },
};

// Fallback model lists shown before the live fetch completes
const FALLBACK_MODELS = {
  gemini:    ["gemini-2.0-flash", "gemini-1.5-flash", "gemini-1.5-flash-8b", "gemini-2.5-flash"],
  openai:    ["gpt-4o-mini", "gpt-4o", "gpt-4-turbo"],
  anthropic: ["claude-haiku-4-5-20251001", "claude-sonnet-4-6", "claude-opus-4-6"],
};

const DEFAULT_PROVIDER = "gemini";

document.getElementById("token-link").href = TOKEN_URL;

// ── Live model fetch from backend ─────────────────────────────────────────────
async function fetchLiveModels(provider, apiKey) {
  try {
    const resp = await fetch(`${BACKEND_URL}/models`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider, api_key: apiKey || null }),
      signal: AbortSignal.timeout(6000),
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    return Array.isArray(data.models) && data.models.length > 0 ? data.models : null;
  } catch {
    return null;
  }
}

// ── Populate model dropdown ───────────────────────────────────────────────────
function setModelOptions(models, selectedModel) {
  const sel = document.getElementById("model");
  sel.innerHTML = models.map((m) => `<option value="${m}">${m}</option>`).join("");
  if (selectedModel && models.includes(selectedModel)) sel.value = selectedModel;
  updateModelInfo(document.getElementById("provider").value, sel.value);
}

async function populateModels(providerId, selectedModel) {
  const config  = PROVIDERS[providerId];
  const fallback = FALLBACK_MODELS[providerId];

  // Show fallback immediately so the UI is responsive
  setModelOptions(fallback, selectedModel);

  // Fetch live list — for Gemini no key needed; for others use saved key
  const needsKey = config.keyRequired;
  const apiKey   = needsKey ? document.getElementById("llm-api-key").value.trim() : null;

  if (!needsKey || apiKey) {
    const live = await fetchLiveModels(providerId, apiKey);
    if (live) {
      // Keep the previously selected model if it still exists in the new list
      const current = document.getElementById("model").value;
      setModelOptions(live, current || selectedModel);
    }
  }
}

// ── Model info / quota hint ───────────────────────────────────────────────────
function updateModelInfo(providerId, modelId) {
  const hint = PROVIDERS[providerId]?.modelHints?.[modelId];
  const el   = document.getElementById("model-info");
  if (!hint) { el.textContent = ""; return; }
  if (hint.quota) {
    const cls = hint.tier === "high" ? "quota-badge quota-high" : "quota-badge quota-low";
    el.innerHTML = `<span class="${cls}">${hint.quota}</span> ${hint.note}`;
  } else {
    el.textContent = hint.note;
  }
}

// ── Show/hide provider API key section ────────────────────────────────────────
function updateProviderUI(providerId) {
  const config  = PROVIDERS[providerId];
  const section = document.getElementById("api-key-section");
  const label   = document.getElementById("api-key-label");
  const input   = document.getElementById("llm-api-key");
  const hint    = document.getElementById("api-key-hint");

  if (config.keyRequired) {
    section.classList.remove("hidden");
    label.textContent = config.label + " API Key";
    input.placeholder = config.keyPlaceholder;
    hint.innerHTML    = config.keyHint;
  } else {
    section.classList.add("hidden");
    hint.innerHTML = config.keyHint;
  }
}

// ── Load saved settings on open ───────────────────────────────────────────────
chrome.storage.local.get([TOKEN_KEY, PROVIDER_KEY, MODEL_KEY, OAI_KEY, ANT_KEY], (data) => {
  if (data[TOKEN_KEY]) {
    document.getElementById("pat").value = data[TOKEN_KEY];
    showStatus("Token saved", "ok");
  }

  const provider = data[PROVIDER_KEY] || DEFAULT_PROVIDER;
  document.getElementById("provider").value = provider;
  updateProviderUI(provider);

  // Restore API key so populateModels can use it for the live fetch
  const apiKeyVal = provider === "openai" ? data[OAI_KEY] : provider === "anthropic" ? data[ANT_KEY] : "";
  if (apiKeyVal) document.getElementById("llm-api-key").value = apiKeyVal;

  populateModels(provider, data[MODEL_KEY]);
});

// ── Provider change ───────────────────────────────────────────────────────────
document.getElementById("provider").addEventListener("change", (e) => {
  const providerId = e.target.value;
  updateProviderUI(providerId);
  document.getElementById("llm-api-key").value = "";
  populateModels(providerId, null);
});

// ── Model change ──────────────────────────────────────────────────────────────
document.getElementById("model").addEventListener("change", (e) => {
  updateModelInfo(document.getElementById("provider").value, e.target.value);
});

// ── Refresh models when API key is entered (OpenAI / Anthropic) ──────────────
document.getElementById("llm-api-key").addEventListener("blur", () => {
  const providerId = document.getElementById("provider").value;
  if (PROVIDERS[providerId].keyRequired) {
    populateModels(providerId, document.getElementById("model").value);
  }
});

// ── Save ──────────────────────────────────────────────────────────────────────
document.getElementById("save").addEventListener("click", () => {
  const token    = document.getElementById("pat").value.trim();
  const provider = document.getElementById("provider").value;
  const model    = document.getElementById("model").value;
  const apiKey   = document.getElementById("llm-api-key").value.trim();

  if (token && !token.startsWith("ghp_") && !token.startsWith("github_pat_")) {
    showStatus("Doesn't look like a valid GitHub token", "err");
    return;
  }

  if (PROVIDERS[provider].keyRequired && !apiKey) {
    showStatus(`${PROVIDERS[provider].label} API key is required`, "err");
    return;
  }

  const toSave = { [PROVIDER_KEY]: provider, [MODEL_KEY]: model };
  if (token)  toSave[TOKEN_KEY] = token;
  if (apiKey) toSave[provider === "openai" ? OAI_KEY : ANT_KEY] = apiKey;

  chrome.storage.local.set(toSave, () => showStatus("Saved!", "ok"));
});

// ── Clear ─────────────────────────────────────────────────────────────────────
document.getElementById("clear").addEventListener("click", () => {
  document.getElementById("pat").value = "";
  document.getElementById("llm-api-key").value = "";
  document.getElementById("provider").value = DEFAULT_PROVIDER;
  updateProviderUI(DEFAULT_PROVIDER);
  populateModels(DEFAULT_PROVIDER, null);
  chrome.storage.local.remove([TOKEN_KEY, PROVIDER_KEY, MODEL_KEY, OAI_KEY, ANT_KEY], () => {
    showStatus("Cleared", "ok");
  });
});

function showStatus(msg, type) {
  const el = document.getElementById("status");
  el.textContent = msg;
  el.className = type === "ok" ? "status-ok" : "status-err";
}
