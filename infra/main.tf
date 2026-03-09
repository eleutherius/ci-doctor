terraform {
  required_version = ">= 1.5"
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 5.0"
    }
  }
}

provider "google" {
  project = var.project_id
  region  = var.region
}

# ── Enable required APIs ───────────────────────────────────────────────────────

resource "google_project_service" "run" {
  service            = "run.googleapis.com"
  disable_on_destroy = false
}

resource "google_project_service" "artifactregistry" {
  service            = "artifactregistry.googleapis.com"
  disable_on_destroy = false
}

resource "google_project_service" "aiplatform" {
  service            = "aiplatform.googleapis.com"
  disable_on_destroy = false
}

# ── Artifact Registry repository ──────────────────────────────────────────────

resource "google_artifact_registry_repository" "ci_doctor" {
  repository_id = "ci-doctor"
  location      = var.region
  format        = "DOCKER"
  description   = "CI Doctor backend images"

  depends_on = [google_project_service.artifactregistry]
}

locals {
  image_url = "${var.region}-docker.pkg.dev/${var.project_id}/ci-doctor/backend:${var.image_tag}"
}

# ── Service account for Cloud Run ─────────────────────────────────────────────

resource "google_service_account" "ci_doctor" {
  account_id   = "ci-doctor-run"
  display_name = "CI Doctor Cloud Run SA"
}

# Allow the SA to call Vertex AI (Gemini)
resource "google_project_iam_member" "ci_doctor_vertex" {
  project = var.project_id
  role    = "roles/aiplatform.user"
  member  = "serviceAccount:${google_service_account.ci_doctor.email}"
}

# ── Cloud Run service ─────────────────────────────────────────────────────────

resource "google_cloud_run_v2_service" "ci_doctor" {
  name     = "ci-doctor"
  location = var.region

  template {
    service_account = google_service_account.ci_doctor.email

    scaling {
      min_instance_count = var.min_instances
      max_instance_count = var.max_instances
    }

    containers {
      image = local.image_url

      ports {
        container_port = 8080
      }

      resources {
        limits = {
          cpu    = "1"
          memory = "512Mi"
        }
        cpu_idle = true
      }

      env {
        name  = "GOOGLE_CLOUD_PROJECT"
        value = var.project_id
      }

      env {
        name  = "GOOGLE_CLOUD_LOCATION"
        value = var.region
      }
    }
  }

  depends_on = [
    google_project_service.run,
    google_project_iam_member.ci_doctor_vertex,
  ]
}

# ── Allow unauthenticated access (needed by the Chrome extension) ─────────────

resource "google_cloud_run_v2_service_iam_member" "public_invoker" {
  name     = google_cloud_run_v2_service.ci_doctor.name
  location = var.region
  role     = "roles/run.invoker"
  member   = "allUsers"
}
