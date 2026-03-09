output "service_url" {
  description = "Public URL of the CI Doctor Cloud Run service"
  value       = google_cloud_run_v2_service.ci_doctor.uri
}

output "image_registry" {
  description = "Artifact Registry URL for pushing images"
  value       = "${var.region}-docker.pkg.dev/${var.project_id}/ci-doctor"
}

output "image_url" {
  description = "Full image URL used by Cloud Run"
  value       = local.image_url
}
