param(
  [Parameter(Mandatory = $true)][string]$DshCommand,
  [string]$PackagePath,
  [string]$DshDataDirectory = (Join-Path $env:USERPROFILE '.dsh')
)

$ErrorActionPreference = 'Stop'
$taskRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if (-not $PackagePath) {
  $packageManifest = Get-Content -LiteralPath (Join-Path $taskRoot 'package.json') -Raw | ConvertFrom-Json
  $PackagePath = Join-Path $taskRoot ($packageManifest.name + '-' + $packageManifest.version + '.tgz')
}
$PackagePath = (Resolve-Path -LiteralPath $PackagePath).Path
$DshCommand = (Resolve-Path -LiteralPath $DshCommand).Path
$profileDirectory = Join-Path $DshDataDirectory 'profiles\desktop'
$backupDirectory = Join-Path $taskRoot ('.test-artifacts\desktop-backup-' + [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssZ'))
New-Item -ItemType Directory -Path $backupDirectory -Force | Out-Null
$backupFiles = @()
foreach ($fileName in @('package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'cordis.patch.yml', 'cordis.yml')) {
  $sourcePath = Join-Path $profileDirectory $fileName
  if (Test-Path -LiteralPath $sourcePath -PathType Leaf) {
    Copy-Item -LiteralPath $sourcePath -Destination (Join-Path $backupDirectory $fileName)
    $backupFiles += $fileName
  }
}
@{ profile = $profileDirectory; files = $backupFiles; package = $PackagePath } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $backupDirectory 'manifest.json') -Encoding utf8
Write-Host "Profile backup: $backupDirectory"
$previousDshDataDirectory = $env:DSH_HOME
try {
  $env:DSH_HOME = $DshDataDirectory
  & $DshCommand plugin --profile desktop add $PackagePath
  if ($LASTEXITCODE -ne 0) { throw "DSH plugin installation failed (exit $LASTEXITCODE). Profile backup: $backupDirectory" }
} finally {
  $env:DSH_HOME = $previousDshDataDirectory
}
Write-Host 'Installed dsh-ssh-workspaces. Reload DSH after upgrading. Open Remote Workspaces in the left sidebar, then choose Light or Full mode for SSH / WSL / Docker. Connected full projects can selectively sync local Skills.'
