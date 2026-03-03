import os
import json
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import Optional
from google import genai
from google.genai import types

app = FastAPI(title="CI Doctor AI API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # In production: ["https://github.com"]
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ─── Request models ───────────────────────────────────────────────────────────
# Must match what content.js sends: { log, context }

class PageContext(BaseModel):
    repo: str = "unknown"
    url: str = ""
    title: str = ""

class AnalyzeRequest(BaseModel):
    log: str
    context: Optional[PageContext] = None

# ─── Response models ──────────────────────────────────────────────────────────
# Must match what content.js renderResult() expects exactly.

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

# ─── Gemini client ────────────────────────────────────────────────────────────

client = genai.Client(
    vertexai=True,
    project=os.environ.get("GOOGLE_CLOUD_PROJECT"),
    location=os.environ.get("GOOGLE_CLOUD_LOCATION", "us-central1"),
)

SYSTEM_PROMPT = """
You are "CI Doctor", an expert Senior DevOps Engineer and CI/CD AI Agent.
Analyze the failed CI/CD pipeline log and determine the exact root cause.
Provide a concise, actionable fix in the JSON schema provided.

Field rules:
- error_type: short label (e.g. "ModuleNotFoundError", "Docker Build Failure", "Peer Dependency Conflict")
- summary: 1-2 sentences describing what went wrong
- file: the single file that needs editing (e.g. "requirements.txt", "Dockerfile", ".github/workflows/ci.yml")
- fix_diff: diff lines showing the minimal change needed. Each line has:
    "type": "added" | "removed" | "context"
    "code": the exact line content (no leading +/-/space)
  Include 1-2 context lines around the change for clarity.
- explanation: 2-3 sentences explaining why this fix resolves the issue
- confidence: integer 0-100 representing your confidence in this diagnosis
"""

# ─── Routes ───────────────────────────────────────────────────────────────────

@app.post("/analyze", response_model=AnalyzeResponse)
async def analyze_logs(request: AnalyzeRequest):
    try:
        repo_info = f"Repository: {request.context.repo}\n" if request.context else ""
        prompt = f"{repo_info}\nFAILED CI LOG:\n{request.log}"

        response = client.models.generate_content(
            model="gemini-2.5-flash",
            contents=prompt,
            config=types.GenerateContentConfig(
                system_instruction=SYSTEM_PROMPT,
                response_mime_type="application/json",
                response_schema=AnalyzeResponse,
                temperature=0.2,
            ),
        )

        return json.loads(response.text)

    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/health")
def health_check():
    return {"status": "ok"}
