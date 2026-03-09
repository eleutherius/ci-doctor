import os
import json
import base64
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from typing import Optional, AsyncIterator
from google import genai
from google.genai import types

app = FastAPI(title="CI Doctor AI API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ─── Vertex AI client ─────────────────────────────────────────────────────────

_PROJECT  = os.environ.get("GOOGLE_CLOUD_PROJECT")
_LOCATION = os.environ.get("GOOGLE_CLOUD_LOCATION", "us-central1")
_MODEL    = os.environ.get("GEMINI_MODEL", "gemini-2.0-flash")

_client = genai.Client(vertexai=True, project=_PROJECT, location=_LOCATION)

# ─── Request / Response models ────────────────────────────────────────────────

class PageContext(BaseModel):
    url:   str = ""
    title: str = ""

class AnalyzeRequest(BaseModel):
    image:      str                    # base64-encoded JPEG/PNG screenshot
    mime_type:  str = "image/jpeg"
    context:    Optional[PageContext] = None
    github_pat: Optional[str] = None   # forwarded from the browser extension

class DiffLine(BaseModel):
    type: str   # "added" | "removed" | "context"
    code: str

class AnalyzeResponse(BaseModel):
    error_type:  str
    summary:     str
    file:        str
    fix_diff:    list[DiffLine]
    explanation: str
    confidence:  int

# ─── Prompt ───────────────────────────────────────────────────────────────────

SYSTEM_PROMPT = """\
You are "CI Doctor", an expert Senior DevOps Engineer and CI/CD AI Agent.
You are given a screenshot of a CI/CD pipeline page (GitHub Actions, Jenkins, GitLab CI, etc.).

Analyze the screenshot visually and determine the root cause of the failure.
ALWAYS produce a best-effort diagnosis — even if the screenshot is partially obscured or unclear.
Never say the screenshot is insufficient; instead infer the most likely cause from whatever is visible.

Field rules:
- error_type: short label (e.g. "ModuleNotFoundError", "Docker Build Failure", "Test Failure")
- summary: 1-2 sentences describing what likely went wrong (use "likely" if uncertain)
- file: the single most probable file that needs editing (e.g. "requirements.txt", ".github/workflows/ci.yml")
- fix_diff: diff lines showing the minimal change needed. Each line has:
    "type": "added" | "removed" | "context"
    "code": the exact line content (no leading +/-/space)
  Include 1-2 context lines around the change for clarity.
- explanation: 2-3 sentences explaining why this fix likely resolves the issue
- confidence: integer 0-100 (use low values like 20-40 if the screenshot is unclear)
"""

# ─── SSE helper ──────────────────────────────────────────────────────────────

def sse(event: dict) -> str:
    return f"data: {json.dumps(event)}\n\n"

# ─── Analysis pipeline ────────────────────────────────────────────────────────

async def analysis_stream(request: AnalyzeRequest) -> AsyncIterator[str]:
    try:
        yield sse({"status": "analyzing", "message": "Analyzing screenshot with Vertex AI..."})

        image_bytes = base64.b64decode(request.image)

        context_text = ""
        if request.context:
            if request.context.url:
                context_text += f"\nPage URL: {request.context.url}"
            if request.context.title:
                context_text += f"\nPage title: {request.context.title}"

        response = _client.models.generate_content(
            model=_MODEL,
            contents=[
                types.Part.from_bytes(data=image_bytes, mime_type=request.mime_type),
                types.Part.from_text(
                    f"Analyze the CI/CD failure shown in this screenshot.{context_text}"
                ),
            ],
            config=types.GenerateContentConfig(
                system_instruction=SYSTEM_PROMPT,
                response_mime_type="application/json",
                response_schema=AnalyzeResponse,
                temperature=0.2,
            ),
        )

        result = json.loads(response.text)
        yield sse({"status": "done", "result": result})

    except Exception as e:
        yield sse({"status": "error", "message": str(e)})

# ─── Routes ──────────────────────────────────────────────────────────────────

@app.post("/analyze")
async def analyze(request: AnalyzeRequest):
    return StreamingResponse(
        analysis_stream(request),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )

@app.get("/health")
def health_check():
    return {"status": "ok"}
