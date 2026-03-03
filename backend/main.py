import os
import re
import json
import base64
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from typing import Optional, AsyncIterator
import httpx
from google import genai
from google.genai import types
import openai as _openai
import anthropic as _anthropic

app = FastAPI(title="CI Doctor AI API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # In production: ["https://github.com"]
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ─── Request / Response models ─────────────────────────────────────────────────

class PageContext(BaseModel):
    repo: str = "unknown"
    url: str = ""
    title: str = ""

ALLOWED_PROVIDERS = {"gemini", "openai", "anthropic"}
DEFAULT_PROVIDER = "gemini"

# Fallback lists (used when live API fetch fails or as validation baseline)
FALLBACK_MODELS = {
    "gemini":    ["gemini-2.0-flash", "gemini-1.5-flash", "gemini-1.5-flash-8b", "gemini-2.5-flash"],
    "openai":    ["gpt-4o-mini", "gpt-4o", "gpt-4-turbo"],
    "anthropic": ["claude-haiku-4-5-20251001", "claude-sonnet-4-6", "claude-opus-4-6"],
}
DEFAULT_MODELS = {
    "gemini":    "gemini-2.0-flash",
    "openai":    "gpt-4o-mini",
    "anthropic": "claude-haiku-4-5-20251001",
}

_MODEL_ID_RE = re.compile(r'^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,79}$')

def is_valid_model_id(model_id: str) -> bool:
    return bool(model_id and _MODEL_ID_RE.match(model_id))

class AnalyzeRequest(BaseModel):
    log: str
    context: Optional[PageContext] = None
    github_pat: Optional[str] = None   # forwarded from the browser extension
    provider: Optional[str] = None     # "gemini" | "openai" | "anthropic"
    model: Optional[str] = None        # model ID within the chosen provider
    llm_api_key: Optional[str] = None  # API key for OpenAI / Anthropic

class DiffLine(BaseModel):
    type: str   # "added" | "removed" | "context"
    code: str

class AnalyzeResponse(BaseModel):
    error_type: str
    summary: str
    file: str
    fix_diff: list[DiffLine]
    explanation: str
    confidence: int

# Pass-1 response: Gemini identifies which files to fetch
class FileIdentification(BaseModel):
    error_type: str
    relevant_files: list[str]   # paths relative to repo root, max 3

# ─── LLM clients ───────────────────────────────────────────────────────────────

_gemini_client = genai.Client(api_key=os.environ.get("GEMINI_API_KEY"))

# ─── Prompts ───────────────────────────────────────────────────────────────────

# Pass-1 prompt: lightweight, focused only on file identification
IDENTIFY_FILES_PROMPT = """\
You are a CI/CD expert. Given a failed CI pipeline log, identify:
1. The error type (short label like "ModuleNotFoundError")
2. Up to 3 file paths relative to the repository root that are most relevant to the failure.

Focus on: files explicitly named in tracebacks, config files that likely need updating
(requirements.txt, package.json, Dockerfile, .github/workflows/*.yml, pyproject.toml, etc.)

Exclude: node_modules, .venv, __pycache__, /tmp, absolute system paths, test fixtures.
"""

# Pass-2 prompt: full analysis with optional file contents
SYSTEM_PROMPT = """\
You are "CI Doctor", an expert Senior DevOps Engineer and CI/CD AI Agent.
Analyze the failed CI/CD pipeline log and determine the root cause.
ALWAYS produce a best-effort diagnosis — even if the log is short or partial.
Never say the log is insufficient; instead infer the most likely cause from whatever is available.

When CURRENT FILE CONTENTS are provided below the log, use them to produce
exact, line-precise diffs that match the real file. Increase confidence accordingly.
If no file contents are provided, produce a representative example diff.

Field rules:
- error_type: short label (e.g. "ModuleNotFoundError", "Docker Build Failure", "Peer Dependency Conflict")
- summary: 1-2 sentences describing what likely went wrong (use "likely" if uncertain)
- file: the single most probable file that needs editing
- fix_diff: diff lines showing the minimal change needed. Each line has:
    "type": "added" | "removed" | "context"
    "code": the exact line content (no leading +/-/space)
  Include 1-2 context lines around the change for clarity.
  When file contents were provided, use the EXACT lines from those files.
- explanation: 2-3 sentences explaining why this fix likely resolves the issue
- confidence: integer 0-100 (use low values like 20-40 if log is sparse, always provide diagnosis)
"""

# JSON schema hints appended to prompts for non-Gemini providers
_PASS1_JSON_HINT = (
    '\n\nRespond ONLY with valid JSON:\n'
    '{"error_type": "short label", "relevant_files": ["path/to/file"]}'
)
_PASS2_JSON_HINT = (
    '\n\nRespond ONLY with valid JSON:\n'
    '{"error_type": "...", "summary": "...", "file": "...", '
    '"fix_diff": [{"type": "added|removed|context", "code": "..."}], '
    '"explanation": "...", "confidence": 50}'
)

# ─── Unified LLM call ──────────────────────────────────────────────────────────

def call_llm_json(
    system: str,
    prompt: str,
    schema_cls,
    provider: str,
    model: str,
    api_key: Optional[str] = None,
    temperature: float = 0.2,
) -> dict:
    """Synchronous call to any supported LLM; returns a parsed JSON dict."""

    if provider == "openai":
        client = _openai.OpenAI(api_key=api_key)
        resp = client.chat.completions.create(
            model=model,
            messages=[
                {"role": "system", "content": system},
                {"role": "user",   "content": prompt},
            ],
            response_format={"type": "json_object"},
            temperature=temperature,
        )
        return json.loads(resp.choices[0].message.content)

    elif provider == "anthropic":
        client = _anthropic.Anthropic(api_key=api_key)
        resp = client.messages.create(
            model=model,
            max_tokens=4096,
            system=system,
            messages=[{"role": "user", "content": prompt}],
            temperature=temperature,
        )
        return json.loads(resp.content[0].text)

    else:  # gemini (default)
        resp = _gemini_client.models.generate_content(
            model=model,
            contents=prompt,
            config=types.GenerateContentConfig(
                system_instruction=system,
                response_mime_type="application/json",
                response_schema=schema_cls,
                temperature=temperature,
            ),
        )
        return json.loads(resp.text)

# ─── GitHub file fetching ──────────────────────────────────────────────────────

# Regex fallback used when Pass-1 is skipped (non-GitHub repos)
_FILE_PATTERNS = [
    r'File "([^"]+\.py)"',
    r'at .+?\(([^)]+\.(?:js|ts|jsx|tsx)):\d+:\d+\)',
    r'(?:error|Error)[:\s]+([^\s:]+\.(?:js|ts|jsx|tsx|py|go|java|rb|rs))',
    r'(\.github/workflows/[^\s"\']+\.ya?ml)',
    r'([^\s"\']+(?:requirements.*\.txt|Pipfile|pyproject\.toml|setup\.py))',
    r'([^\s"\']+package(?:-lock)?\.json)',
    r'([^\s"\']+Dockerfile[^\s"\']*)',
]

def extract_file_paths_regex(log: str) -> list[str]:
    seen: set[str] = set()
    paths: list[str] = []
    for pattern in _FILE_PATTERNS:
        for m in re.finditer(pattern, log):
            path = m.group(1).strip().lstrip("/")
            if path.startswith(("http", "tmp/", "/tmp")) or len(path) > 120:
                continue
            if path not in seen:
                seen.add(path)
                paths.append(path)
    return paths[:5]


async def identify_relevant_files(
    log: str, repo: str, provider: str, model: str, api_key: Optional[str]
) -> list[str]:
    """Pass 1 — ask the LLM which source files are relevant to the failure."""
    # For Jenkins or unresolvable repos, fall back to regex
    if "/" not in repo or repo.startswith("Jenkins"):
        return extract_file_paths_regex(log)
    try:
        system = IDENTIFY_FILES_PROMPT + (
            "" if provider == "gemini" else _PASS1_JSON_HINT
        )
        result = call_llm_json(
            system=system,
            prompt=f"Repository: {repo}\n\nFAILED CI LOG:\n{log[:8000]}",
            schema_cls=FileIdentification,
            provider=provider,
            model=model,
            api_key=api_key,
            temperature=0.1,
        )
        files = [
            f.lstrip("/")
            for f in result.get("relevant_files", [])
            if f and len(f) < 120 and not f.startswith("http")
        ]
        return files[:3]
    except Exception as e:
        print(f"[CI Doctor] Pass-1 failed, using regex fallback: {e}")
        return extract_file_paths_regex(log)


async def fetch_github_file(repo: str, path: str, token: Optional[str]) -> Optional[str]:
    """Fetch a single file from the GitHub Contents API."""
    url = f"https://api.github.com/repos/{repo}/contents/{path}"
    headers = {"Accept": "application/vnd.github.v3+json"}
    if token:
        headers["Authorization"] = f"token {token}"
    try:
        async with httpx.AsyncClient(timeout=5.0) as http:
            resp = await http.get(url, headers=headers)
            if resp.status_code != 200:
                return None
            data = resp.json()
            if data.get("encoding") == "base64":
                content = base64.b64decode(data["content"]).decode("utf-8", errors="replace")
                if len(content) > 3000:
                    content = content[:3000] + "\n...[file truncated]"
                return content
    except Exception:
        pass
    return None


async def fetch_files_by_paths(paths: list[str], repo: str, token: Optional[str]) -> str:
    """Fetch a list of files and format them for the prompt."""
    if "/" not in repo or repo.startswith("Jenkins") or not paths:
        return ""
    parts: list[str] = []
    for path in paths:
        content = await fetch_github_file(repo, path, token)
        if content:
            parts.append(f"\n\n--- CURRENT FILE CONTENTS: {path} ---\n{content}")
    return "".join(parts)

# ─── SSE helpers ───────────────────────────────────────────────────────────────

def sse(event: dict) -> str:
    """Format a dict as a Server-Sent Events data line."""
    return f"data: {json.dumps(event)}\n\n"

# ─── Streaming analysis pipeline ───────────────────────────────────────────────

async def analysis_stream(request: AnalyzeRequest) -> AsyncIterator[str]:
    repo = request.context.repo if request.context else "unknown"

    provider = request.provider if request.provider in ALLOWED_PROVIDERS else DEFAULT_PROVIDER
    model = request.model if is_valid_model_id(request.model or "") else DEFAULT_MODELS[provider]
    api_key = request.llm_api_key or None
    provider_label = {"gemini": "Gemini", "openai": "OpenAI", "anthropic": "Claude"}.get(provider, provider)

    try:
        # ── Stage 1: Identify relevant files ─────────────────────────────────
        yield sse({"status": "identifying", "message": "Identifying error type..."})
        relevant_files = await identify_relevant_files(request.log, repo, provider, model, api_key)

        # ── Stage 2: Fetch source files from GitHub ───────────────────────────
        file_context = ""
        if relevant_files and "/" in repo and not repo.startswith("Jenkins"):
            short_names = ", ".join(f.split("/")[-1] for f in relevant_files)
            yield sse({
                "status": "fetching",
                "message": f"Fetching {short_names}...",
                "files": relevant_files,
            })
            file_context = await fetch_files_by_paths(relevant_files, repo, request.github_pat)

        # ── Stage 3: Generate the fix ─────────────────────────────────────────
        yield sse({"status": "analyzing", "message": f"Generating fix with {provider_label} ({model})..."})

        system = SYSTEM_PROMPT + ("" if provider == "gemini" else _PASS2_JSON_HINT)
        prompt = f"Repository: {repo}\n\nFAILED CI LOG:\n{request.log}{file_context}"

        result = call_llm_json(
            system=system,
            prompt=prompt,
            schema_cls=AnalyzeResponse,
            provider=provider,
            model=model,
            api_key=api_key,
            temperature=0.2,
        )
        yield sse({"status": "done", "result": result, "provider": provider})

    except Exception as e:
        msg = str(e)
        if "429" in msg or "RESOURCE_EXHAUSTED" in msg or "quota" in msg.lower() or "rate limit" in msg.lower():
            yield sse({"status": "error", "message": (
                f"{provider_label} quota exceeded. "
                "Select a different model or provider below and retry."
            )})
        elif "404" in msg or "NOT_FOUND" in msg or ("not found" in msg.lower() and "model" in msg.lower()):
            yield sse({"status": "error", "message": (
                f"Model `{model}` is not available via {provider_label}. "
                "Select a different model below and retry."
            )})
        else:
            yield sse({"status": "error", "message": msg})

# ─── Routes ────────────────────────────────────────────────────────────────────

@app.post("/analyze")
async def analyze_logs(request: AnalyzeRequest):
    return StreamingResponse(
        analysis_stream(request),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


class ModelsRequest(BaseModel):
    provider: str
    api_key: Optional[str] = None


@app.post("/models")
def list_models(request: ModelsRequest):
    """Return available models for the given provider, queried live from the provider API."""
    provider = request.provider
    api_key  = request.api_key

    if provider == "gemini":
        try:
            _GEMINI_SKIP = {"embedding", "aqa", "gemma", "learnlm", "imagen"}
            models = []
            for m in _gemini_client.models.list():
                name    = m.name.removeprefix("models/")
                actions = getattr(m, "supported_actions", None) or []
                if "generateContent" not in actions:
                    continue
                if not name.startswith("gemini-"):
                    continue
                if any(x in name for x in _GEMINI_SKIP):
                    continue
                models.append(name)
            models.sort(reverse=True)
            return {"models": models or FALLBACK_MODELS["gemini"]}
        except Exception as e:
            return {"models": FALLBACK_MODELS["gemini"], "error": str(e)}

    elif provider == "openai":
        if not api_key:
            return {"models": FALLBACK_MODELS["openai"]}
        try:
            oai = _openai.OpenAI(api_key=api_key)
            all_models = oai.models.list()
            _OAI_PREFIXES = ("gpt-4", "gpt-3.5-turbo", "o1-", "o3-", "o4-")
            _OAI_EXCLUDE  = ("instruct", "vision", "search", "audio", "realtime",
                             "tts", "whisper", "dall-e", "embedding", "preview-")
            models = sorted(
                {
                    m.id for m in all_models.data
                    if any(m.id.startswith(p) for p in _OAI_PREFIXES)
                    and not any(x in m.id for x in _OAI_EXCLUDE)
                },
                reverse=True,
            )
            return {"models": models or FALLBACK_MODELS["openai"]}
        except Exception as e:
            return {"models": FALLBACK_MODELS["openai"], "error": str(e)}

    elif provider == "anthropic":
        if not api_key:
            return {"models": FALLBACK_MODELS["anthropic"]}
        try:
            ac = _anthropic.Anthropic(api_key=api_key)
            result = ac.models.list()
            models = [m.id for m in result.data]
            return {"models": models or FALLBACK_MODELS["anthropic"]}
        except Exception as e:
            return {"models": FALLBACK_MODELS["anthropic"], "error": str(e)}

    return {"models": []}


@app.get("/health")
def health_check():
    return {"status": "ok"}
