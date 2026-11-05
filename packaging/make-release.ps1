<#
  Builds the release zip: the packaged app (without the git history and the tests), the installer, and a checksum.

    .\packaging\make-release.ps1                     writes ..\..\..\release\Flowdeck-<version>-win-x64.zip
    .\packaging\make-release.ps1 -Out C:\somewhere   writes it somewhere else
    .\packaging\make-release.ps1 -Force              replaces a zip of the same version (a published one never should be)

  The version comes from package.json. Run the tests first: npm test.
#>
[CmdletBinding()]
param(
  [string]$Out,
  [switch]$Force
)
$ErrorActionPreference = 'Stop'

$app = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path            # resources\app: the source
$runtime = (Resolve-Path (Join-Path $app '..\..')).Path               # the Flowdeck folder holding Flowdeck.exe
if (-not (Test-Path (Join-Path $runtime 'Flowdeck.exe'))) { throw "Flowdeck.exe not found in $runtime" }
if (-not $Out) { $Out = Join-Path (Split-Path $runtime -Parent) 'release' }
$version = (Get-Content (Join-Path $app 'package.json') -Raw | ConvertFrom-Json).version
$name = "Flowdeck-$version-win-x64"
$zip = Join-Path $Out "$name.zip"
if ((Test-Path $zip) -and -not $Force) { throw "$zip already exists. A published release should never be overwritten: bump the version in package.json, or pass -Force." }

$stage = Join-Path ([IO.Path]::GetTempPath()) "flowdeck-stage-$([guid]::NewGuid().ToString('N').Substring(0, 8))"
try {
  $null = New-Item -ItemType Directory -Force -Path $stage, $Out
  Write-Host "Staging Flowdeck $version ..."
  # Developer-only things stay out of the release: git history, tests, packaging scripts, dependencies, logs.
  & robocopy $runtime (Join-Path $stage 'Flowdeck') /E /XD '.git' 'test' 'packaging' 'node_modules' /XF '*.log' '*.tmp' /NFL /NDL /NJH /NJS /NP | Out-Null
  if ($LASTEXITCODE -ge 8) { throw "Staging failed (robocopy exit code $LASTEXITCODE)" }
  foreach ($f in 'Install-Flowdeck.ps1', 'Install Flowdeck.cmd', 'README-INSTALL.txt') { Copy-Item (Join-Path $PSScriptRoot $f) $stage }

  if (Test-Path $zip) { Remove-Item $zip -Force }
  Write-Host "Zipping to $zip ..."
  & tar -a -cf $zip -C $stage .
  if ($LASTEXITCODE -ne 0) { throw "tar failed with exit code $LASTEXITCODE" }
  $sha = (Get-FileHash $zip -Algorithm SHA256).Hash.ToLower()
  Set-Content -Path "$zip.sha256" -Value "$sha  $name.zip" -Encoding ascii
  Write-Host ("Built {0}  ({1:N1} MB)" -f $zip, ((Get-Item $zip).Length / 1MB))
  Write-Host "SHA-256: $sha"
} finally {
  if (Test-Path $stage) { Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue }
}
