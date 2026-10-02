$ErrorActionPreference = "Stop"

$taskName = "OpenAI Route Controller"
$repoRoot = Split-Path $PSScriptRoot -Parent
$installRoot = if ($env:OPENAI_ROUTE_CONTROLLER_HOME) {
  $env:OPENAI_ROUTE_CONTROLLER_HOME
} else {
  Join-Path $env:LOCALAPPDATA "OpenAI Route Controller"
}
$apiUrl = if ($env:MIHOMO_API) {
  $env:MIHOMO_API.TrimEnd("/")
} else {
  "http://127.0.0.1:9097"
}
$proxyUrl = if ($env:MIHOMO_PROXY) {
  $env:MIHOMO_PROXY
} else {
  "http://127.0.0.1:7897"
}
$groupName = if ($env:OPENAI_GROUP) {
  $env:OPENAI_GROUP
} else {
  "OpenAI 自动选择"
}

if ($PSVersionTable.PSVersion.Major -lt 5) {
  throw "Windows PowerShell 5.1 or newer is required."
}
$nodePath = (Get-Command node.exe -ErrorAction Stop).Source
$null = Get-Command curl.exe -ErrorAction Stop
$nodeMajor = [int]((& $nodePath -p 'Number(process.versions.node.split(".")[0])').Trim())
if ($nodeMajor -lt 22) {
  throw "Node.js 22 or newer is required."
}

foreach ($uriText in @($apiUrl, $proxyUrl)) {
  $uri = [Uri]$uriText
  if ($uri.Scheme -notin @("http", "https")) {
    throw "Only HTTP(S) loopback endpoints are supported: $uriText"
  }
  if ($uri.Host -notin @("127.0.0.1", "localhost", "::1")) {
    throw "Refusing a non-loopback Mihomo endpoint: $uriText"
  }
}

Push-Location $repoRoot
try {
  & npm.cmd run verify
  if ($LASTEXITCODE -ne 0) { throw "Repository verification failed." }
} finally {
  Pop-Location
}

$secureSecret = Read-Host "Mihomo External Controller secret" -AsSecureString
if ($secureSecret.Length -eq 0) {
  throw "Mihomo External Controller secret must not be empty."
}
$encryptedSecret = ConvertFrom-SecureString $secureSecret
$secretPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureSecret)
$shadowState = Join-Path $env:TEMP "openai-route-controller-shadow-$PID.json"

try {
  $plainSecret = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($secretPointer)
  $headers = @{ Authorization = "Bearer $plainSecret" }
  $null = Invoke-RestMethod -Uri "$apiUrl/version" -Headers $headers -TimeoutSec 5

  $env:MIHOMO_API = $apiUrl
  $env:MIHOMO_SECRET = $plainSecret
  $env:MIHOMO_PROXY = $proxyUrl
  $env:OPENAI_GROUP = $groupName
  $env:STATE_PATH = $shadowState
  $env:CURL_PATH = (Get-Command curl.exe -ErrorAction Stop).Source
  & $nodePath (Join-Path $repoRoot "controller.mjs") --once --shadow
  if ($LASTEXITCODE -ne 0) { throw "Shadow validation failed." }
} finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($secretPointer)
  Remove-Item Env:MIHOMO_SECRET -ErrorAction SilentlyContinue
  Remove-Item -Force -ErrorAction SilentlyContinue $shadowState
}

$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
if (Test-Path $installRoot) {
  $backupRoot = Join-Path $installRoot "backups\$timestamp"
  New-Item -ItemType Directory -Force $backupRoot | Out-Null
  foreach ($fileName in @("controller.mjs", "lib.mjs", "logging.mjs", "start-controller.ps1", "settings.json", "node.path", "mihomo.secret.dpapi")) {
    $existing = Join-Path $installRoot $fileName
    if (Test-Path $existing) {
      Copy-Item $existing (Join-Path $backupRoot $fileName)
    }
  }
  Write-Output "Existing files backed up to: $backupRoot"
}
New-Item -ItemType Directory -Force $installRoot | Out-Null

$existingTask = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($existingTask) {
  Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
}

Copy-Item (Join-Path $repoRoot "controller.mjs") (Join-Path $installRoot "controller.mjs") -Force
Copy-Item (Join-Path $repoRoot "lib.mjs") (Join-Path $installRoot "lib.mjs") -Force
Copy-Item (Join-Path $repoRoot "logging.mjs") (Join-Path $installRoot "logging.mjs") -Force
Copy-Item (Join-Path $PSScriptRoot "start-controller.ps1") (Join-Path $installRoot "start-controller.ps1") -Force
Set-Content -NoNewline -Encoding UTF8 (Join-Path $installRoot "node.path") $nodePath
Set-Content -NoNewline -Encoding UTF8 (Join-Path $installRoot "mihomo.secret.dpapi") $encryptedSecret
@{
  apiUrl = $apiUrl
  proxyUrl = $proxyUrl
  groupName = $groupName
} | ConvertTo-Json | Set-Content -Encoding UTF8 (Join-Path $installRoot "settings.json")

$identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
foreach ($protectedFile in @("node.path", "mihomo.secret.dpapi", "settings.json")) {
  & icacls.exe (Join-Path $installRoot $protectedFile) /inheritance:r /grant:r "${identity}:(R)" | Out-Null
}

$powerShellPath = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
$launcherPath = Join-Path $installRoot "start-controller.ps1"
$arguments = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$launcherPath`""
$action = New-ScheduledTaskAction -Execute $powerShellPath -Argument $arguments -WorkingDirectory $installRoot
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $identity
$principal = New-ScheduledTaskPrincipal -UserId $identity -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet `
  -RestartCount 100 `
  -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -MultipleInstances IgnoreNew `
  -StartWhenAvailable `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries

Register-ScheduledTask `
  -TaskName $taskName `
  -Action $action `
  -Trigger $trigger `
  -Principal $principal `
  -Settings $settings `
  -Description "Validates and switches the OpenAI proxy route" `
  -Force | Out-Null
Start-ScheduledTask -TaskName $taskName

Write-Output "Installed and started scheduled task: $taskName"
Write-Output "Install directory: $installRoot"
