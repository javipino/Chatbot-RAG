# deploy.ps1 — Deploy only app files to Azure App Service (avoids 334MB data/ bloat)
# Usage: .\deploy.ps1

$ErrorActionPreference = "Stop"

$appName = "chatbot-rag-javi"
$resourceGroup = "rg-chatbot-rag"
$stagingDir = "$PSScriptRoot\.deploy-staging"
$zipFile = "$PSScriptRoot\.deploy.zip"

Write-Host "=== Preparing deploy payload ===" -ForegroundColor Cyan

# Clean staging directory
if (Test-Path $stagingDir) { Remove-Item $stagingDir -Recurse -Force }
New-Item $stagingDir -ItemType Directory | Out-Null

# Copy only what the App Service needs
Copy-Item "$PSScriptRoot\server" "$stagingDir\server" -Recurse
Copy-Item "$PSScriptRoot\public" "$stagingDir\public" -Recurse
Copy-Item "$PSScriptRoot\package.json" "$stagingDir\"
Copy-Item "$PSScriptRoot\package-lock.json" "$stagingDir\" -ErrorAction SilentlyContinue

# Install production dependencies locally (avoid Oryx build on server = saves CPU quota)
Write-Host "Installing dependencies..." -ForegroundColor Yellow
Push-Location $stagingDir
npm install --omit=dev --silent 2>&1 | Out-Null
Pop-Location

$size = (Get-ChildItem $stagingDir -Recurse -File | Measure-Object -Property Length -Sum).Sum
Write-Host "Payload: $("{0:N1}" -f ($size/1MB)) MB (with node_modules)" -ForegroundColor Green

# Create zip
if (Test-Path $zipFile) { Remove-Item $zipFile -Force }
Compress-Archive -Path "$stagingDir\*" -DestinationPath $zipFile
Write-Host "Zip: $("{0:N1}" -f ((Get-Item $zipFile).Length/1MB)) MB"

# Deploy via zip deploy (skips Oryx build = saves CPU quota on F1)
Write-Host "`n=== Deploying to $appName ===" -ForegroundColor Cyan
az webapp config appsettings set --name $appName --resource-group $resourceGroup --settings SCM_DO_BUILD_DURING_DEPLOYMENT=false 2>&1 | Out-Null
az webapp deploy --name $appName --resource-group $resourceGroup --src-path $zipFile --type zip --clean true 2>&1

# Cleanup
Remove-Item $stagingDir -Recurse -Force
Remove-Item $zipFile -Force

Write-Host "`n=== Done ===" -ForegroundColor Green
Write-Host "URL: https://$appName.azurewebsites.net"
