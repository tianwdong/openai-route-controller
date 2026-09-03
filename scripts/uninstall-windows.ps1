$ErrorActionPreference = "Stop"

$taskName = "OpenAI Route Controller"
$task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($task) {
  Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
  Write-Output "Scheduled task removed: $taskName"
} else {
  Write-Output "Scheduled task was not installed: $taskName"
}

Write-Output "Controller files, state, backups, and logs were preserved for manual review."
