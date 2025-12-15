$ImageName = "public.ecr.aws/ingext/ingext-shell:latest"
$HomeDir = $env:USERPROFILE

# Ensure local config directories exist
if (-not (Test-Path "$HomeDir\.kube"))  { New-Item -ItemType Directory -Path "$HomeDir\.kube" | Out-Null }
if (-not (Test-Path "$HomeDir\.aws"))   { New-Item -ItemType Directory -Path "$HomeDir\.aws" | Out-Null }
if (-not (Test-Path "$HomeDir\.azure")) { New-Item -ItemType Directory -Path "$HomeDir\.azure" | Out-Null }
if (-not (Test-Path "$HomeDir\.ssh"))   { New-Item -ItemType Directory -Path "$HomeDir\.ssh" | Out-Null }
if (-not (Test-Path "$HomeDir\.helm"))  { New-Item -ItemType Directory -Path "$HomeDir\.helm" | Out-Null } # <--- Added

# 1. Create the history file if it doesn't exist
if (-not (Test-Path "$HomeDir\.ingext_shell_history")) { New-Item -ItemType File -Path "$HomeDir\.ingext_shell_history" | Out-Null }

Write-Host "🚀 Launching Multi-Cloud Toolbox from: $ImageName" -ForegroundColor Cyan

docker run -it --rm --pull always `
  -v "${PWD}:/workspace" `
  -v "${HomeDir}\.kube:/root/.kube" `
  -v "${HomeDir}\.aws:/root/.aws" `
  -v "${HomeDir}\.azure:/root/.azure" `
  -v "${HomeDir}\.helm:/root/.helm" `
  -v "${HomeDir}\.ingext_shell_history:/root/.bash_history" `
  -v "${HomeDir}\.ssh:/root/.ssh:ro" `
  -w "/workspace" `
  $ImageName
