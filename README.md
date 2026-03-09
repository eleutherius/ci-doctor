# CI-Docktor 🩺

**CI-Docktor** is an AI-powered Chrome extension that helps developers diagnose and understand CI failures directly inside GitHub Actions.

When a CI pipeline fails, engineers often spend a lot of time scrolling through logs to find the root cause. CI-Docktor simplifies this process by analyzing CI logs with Gemini and providing a clear explanation of what went wrong.

With one click, developers can analyze a failed workflow, receive a diagnosis, and optionally generate a suggested fix or draft merge request.

---

## Features

- 🔍 Analyze failed **GitHub Actions** workflows
- 🧠 AI-powered **CI log analysis**
- 📋 Clear explanation of the **root cause**
- ⚙️ Suggested remediation steps
- 🔧 Optional **fix proposal or draft merge request**

---

## How It Works

1. Open a failed **GitHub Actions** run.
2. Click **Analyze with CI-Docktor** in the Chrome extension.
3. CI-Docktor extracts the CI logs.
4. Gemini analyzes the logs and identifies the likely cause.
5. The extension displays:
   - failure diagnosis
   - explanation
   - suggested fix

---

## Tech Stack

- Gemini
- Google Vertex AI
- Python
- FastAPI
- Google GenAI SDK
- Chrome Extension (JavaScript)
- GitHub API

---

## Future Improvements

- Support for **Jenkins pipelines**
- Automated **PR generation**
- Integration with **additional CI/CD platforms**
- Smarter failure classification