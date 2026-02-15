# deploy.ps1 — Deploy app to Azure App Service via Kudu zipdeploy
# Usage: .\deploy.ps1
# Requires: az CLI logged in, correct subscription selected

$ErrorActionPreference = "Stop"

$appName = "chatbot-rag-javi"
$resourceGroup = "rg-chatbot-rag"
$stagingDir = (Join-Path $PSScriptRoot ".deploy-staging")
$zipFile = (Join-Path $PSScriptRoot ".deploy.zip")

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
$npmOutput = cmd /c "npm install --omit=dev --silent 2>&1"
if ($LASTEXITCODE -ne 0) { Pop-Location; throw "npm install failed: $npmOutput" }
Pop-Location

$size = (Get-ChildItem $stagingDir -Recurse -File | Measure-Object -Property Length -Sum).Sum
Write-Host "Payload: $("{0:N1}" -f ($size/1MB)) MB (with node_modules)" -ForegroundColor Green

# Create zip with forward-slash paths (Compress-Archive uses backslashes which break Linux rsync)
if (Test-Path $zipFile) { Remove-Item $zipFile -Force }
Add-Type -Assembly "System.IO.Compression"
$resolvedStaging = (Get-Item $stagingDir).FullName
$zip = [System.IO.Compression.ZipFile]::Open($zipFile, 'Create')
foreach ($f in (Get-ChildItem $resolvedStaging -Recurse -File)) {
    $rel = $f.FullName.Substring($resolvedStaging.Length + 1).Replace('\', '/')
    [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
        $zip, $f.FullName, $rel, 'Fastest') | Out-Null
}
$zip.Dispose()
Write-Host "Zip: $("{0:N1}" -f ((Get-Item $zipFile).Length/1MB)) MB"

# Deploy via Kudu zipdeploy API (bearer token auth)
Write-Host "`n=== Deploying to $appName ===" -ForegroundColor Cyan
$ErrorActionPreference = "Continue"
$token = az account get-access-token --query accessToken -o tsv 2>$null
$ErrorActionPreference = "Stop"
if (-not $token) { throw "Failed to get Azure access token. Run 'az login' first." }

$zipBytes = [System.IO.File]::ReadAllBytes($zipFile)
Write-Host "Uploading $([math]::Round($zipBytes.Length/1KB)) KB..."

$resp = Invoke-WebRequest `
    -Uri "https://$appName.scm.azurewebsites.net/api/zipdeploy?isAsync=true" `
    -Method Post `
    -Headers @{ Authorization = "Bearer $token" } `
    -ContentType "application/zip" `
    -Body $zipBytes `
    -TimeoutSec 120 `
    -UseBasicParsing

if ($resp.StatusCode -ne 202) { throw "Zipdeploy failed: HTTP $($resp.StatusCode)" }
Write-Host "Deploy accepted (HTTP 202). Polling status..."

# Poll deployment status
$headers = @{ Authorization = "Bearer $token" }
for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep 5
    $deps = Invoke-RestMethod -Uri "https://$appName.scm.azurewebsites.net/api/deployments" -Headers $headers
    $latest = $deps | Select-Object -First 1
    if ($latest.complete) {
        if ($latest.status -eq 4) {
            Write-Host "Deploy succeeded!" -ForegroundColor Green
        } else {
            throw "Deploy failed (status=$($latest.status)). Check Kudu logs."
        }
        break
    }
    Write-Host "  Still deploying... ($($i * 5)s)"
}

# Cleanup
Remove-Item $stagingDir -Recurse -Force
Remove-Item $zipFile -Force

Write-Host "`n=== Done ===" -ForegroundColor Green
Write-Host "URL: https://$appName.azurewebsites.net"
