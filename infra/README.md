# CI Doctor — Infrastructure

Deploys the CI Doctor backend to **Google Cloud Run** using Terraform.

## What gets created

| Resource | Name |
|---|---|
| Artifact Registry | `ci-doctor` |
| Secret Manager secret | `gemini-api-key` |
| Service Account | `ci-doctor-run` |
| Cloud Run service | `ci-doctor` |

## Prerequisites

- [Terraform](https://developer.hashicorp.com/terraform/install) >= 1.5
- [gcloud CLI](https://cloud.google.com/sdk/docs/install)
- A Google Cloud project with billing enabled

## Setup

### 1. Authenticate

```bash
gcloud auth application-default login
```

### 2. Build and push the Docker image

```bash
gcloud auth configure-docker us-central1-docker.pkg.dev

docker build -t us-central1-docker.pkg.dev/YOUR_PROJECT/ci-doctor/backend:latest ./backend
docker push us-central1-docker.pkg.dev/YOUR_PROJECT/ci-doctor/backend:latest
```

> First time: run `terraform apply` first to create the Artifact Registry, then push the image.

### 3. Configure variables

```bash
cp terraform.tfvars.example terraform.tfvars
# edit terraform.tfvars with your values
```

### 4. Deploy

```bash
terraform init
terraform apply
```

### 5. Get the service URL

```bash
terraform output service_url
```

Update `BACKEND_URL` in the Chrome extension with this URL.

## Updating the backend

```bash
docker build -t us-central1-docker.pkg.dev/YOUR_PROJECT/ci-doctor/backend:latest ./backend
docker push us-central1-docker.pkg.dev/YOUR_PROJECT/ci-doctor/backend:latest

terraform apply -var="image_tag=latest"
```

Or use a versioned tag (recommended):

```bash
TAG=v1.2.3
docker build -t us-central1-docker.pkg.dev/YOUR_PROJECT/ci-doctor/backend:$TAG ./backend
docker push us-central1-docker.pkg.dev/YOUR_PROJECT/ci-doctor/backend:$TAG

terraform apply -var="image_tag=$TAG"
```

## Tear down

```bash
terraform destroy
```
