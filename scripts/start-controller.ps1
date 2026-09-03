$ErrorActionPreference = "Stop"

$installRoot = $PSScriptRoot
$settings = Get-Content (Join-Path $installRoot "settings.json") -Raw | ConvertFrom-Json
$nodePath = (Get-Content (Join-Path $installRoot "node.path") -Raw).Trim()
$encryptedSecret = (Get-Content (Join-Path $installRoot "mihomo.secret.dpapi") -Raw).Trim()
$secureSecret = ConvertTo-SecureString $encryptedSecret
$secretPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureSecret)
$controllerExitCode = 1

try {
  $env:MIHOMO_API = $settings.apiUrl
  $env:MIHOMO_SECRET = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($secretPointer)
  $env:MIHOMO_PROXY = $settings.proxyUrl
  $env:OPENAI_GROUP = $settings.groupName
  $env:STATE_PATH = Join-Path $installRoot "state.json"
  $env:CURL_PATH = (Get-Command curl.exe -ErrorAction Stop).Source

  $stdoutLog = Join-Path $installRoot "controller.log"
  $stderrLog = Join-Path $installRoot "controller.error.log"
  foreach ($logPath in @($stdoutLog, $stderrLog)) {
    if ((Test-Path $logPath) -and (Get-Item $logPath).Length -gt 20MB) {
      Move-Item -Force $logPath "$logPath.1"
    }
  }

  & $nodePath (Join-Path $installRoot "controller.mjs") 1>> $stdoutLog 2>> $stderrLog
  $controllerExitCode = $LASTEXITCODE
} finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($secretPointer)
  Remove-Item Env:MIHOMO_SECRET -ErrorAction SilentlyContinue
}

exit $controllerExitCode
