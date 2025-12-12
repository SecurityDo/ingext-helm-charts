# --- Configuration ---
# Updated to your ECR Public repository
$ImageName = "public.ecr.aws/ingext/ingext-shell:latest"
$HomeDir = $env:USERPROFILE

# --- Pre-flight Checks ---
# Ensure local config directories exist
if (-not (Test-Path "$HomeDir\.kube")) { New-Item -ItemType Directory -Path "$HomeDir\.kube" | Out-Null }
if (-not (Test-Path "$HomeDir\.aws"))  { New-Item -ItemType Directory -Path "$HomeDir\.aws" | Out-Null }
if (-not (Test-Path "$HomeDir\.azure")) { New-Item -ItemType Directory -Path "$HomeDir\.azure" | Out-Null }
if (-not (Test-Path "$HomeDir\.ssh"))   { New-Item -ItemType Directory -Path "$HomeDir\.ssh" | Out-Null }

Write-Host "🚀 Launching Multi-Cloud Toolbox from: $ImageName" -ForegroundColor Cyan

# --- Run Container ---
# --pull always ensures they get the latest image every time they run it
docker run -it --rm --pull always `
  -v "${PWD}:/workspace" `
  -v "${HomeDir}\.kube:/root/.kube" `
  -v "${HomeDir}\.aws:/root/.aws" `
  -v "${HomeDir}\.azure:/root/.azure" `
  -v "${HomeDir}\.ssh:/root/.ssh:ro" `
  -w "/workspace" `
  $ImageName
