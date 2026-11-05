<#
  Installs Flowdeck for the current user. No administrator rights needed.

    Install:    double-click "Install Flowdeck.cmd" (it runs this script)
    Uninstall:  Settings > Apps > Flowdeck > Uninstall (or run this script with -Uninstall)

  What it does: copies the app to %LOCALAPPDATA%\Programs\Flowdeck, adds a Start-menu shortcut (and a desktop one if
  asked), and adds an entry to Settings > Apps. Installing again over an older version upgrades it: the old files are
  replaced. Your library, covers and preferences live in %APPDATA%\Flowdeck and are never touched, unless you uninstall
  with -RemoveUserData.

  Run it from the unzipped release folder, next to the "Flowdeck" folder. Every location can be changed with a
  parameter, which is how the tests run it without touching the real machine.
#>
[CmdletBinding()]
param(
  [string]$Prefix = (Join-Path $env:LOCALAPPDATA 'Programs\Flowdeck'),
  [string]$StartMenuDir = [Environment]::GetFolderPath('Programs'),
  [string]$DesktopDir = [Environment]::GetFolderPath('Desktop'),
  [string]$RegistryKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Flowdeck',
  [string]$UserDataDir = (Join-Path $env:APPDATA 'Flowdeck'),
  [switch]$DesktopShortcut,
  [switch]$NoRegistry,
  [switch]$NoLaunch,
  [switch]$Uninstall,
  [switch]$RemoveUserData
)
$ErrorActionPreference = 'Stop'

function Stop-FlowdeckAt([string]$dir) {
  # Only copies running from this folder: another Flowdeck elsewhere is left alone.
  $mine = Get-Process -Name Flowdeck -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path.StartsWith($dir, [StringComparison]::OrdinalIgnoreCase) }
  foreach ($p in $mine) {
    Write-Host "Closing Flowdeck (process $($p.Id))..."
    $null = $p.CloseMainWindow()
    if (-not $p.WaitForExit(8000)) { $p.Kill(); $null = $p.WaitForExit(5000) }
  }
}

function New-Shortcut([string]$file, [string]$target, [string]$icon, [string]$workDir) {
  $null = New-Item -ItemType Directory -Force -Path (Split-Path $file)
  $shell = New-Object -ComObject WScript.Shell
  $lnk = $shell.CreateShortcut($file)
  $lnk.TargetPath = $target
  $lnk.WorkingDirectory = $workDir
  $lnk.Description = 'Flowdeck: a cover-flow player for music, videos and photos'
  if (Test-Path $icon) { $lnk.IconLocation = $icon }
  $lnk.Save()
}

function Test-ShortcutTo([string]$file, [string]$exe) {
  if (-not (Test-Path $file)) { return $false }
  $shell = New-Object -ComObject WScript.Shell
  return ($shell.CreateShortcut($file).TargetPath -ieq $exe)
}

$exe = Join-Path $Prefix 'Flowdeck.exe'
$icon = Join-Path $Prefix 'resources\app\assets\icon.ico'
$startLnk = Join-Path $StartMenuDir 'Flowdeck.lnk'
$desktopLnk = Join-Path $DesktopDir 'Flowdeck.lnk'

if ($Uninstall) {
  Stop-FlowdeckAt $Prefix
  # Only shortcuts that point at this install are removed.
  foreach ($f in @($startLnk, $desktopLnk)) { if (Test-ShortcutTo $f $exe) { Remove-Item $f -Force; Write-Host "Removed $f" } }
  if (-not $NoRegistry -and (Test-Path $RegistryKey)) { Remove-Item $RegistryKey -Recurse -Force; Write-Host 'Removed the Settings > Apps entry.' }
  if ($RemoveUserData -and (Test-Path $UserDataDir)) { Remove-Item $UserDataDir -Recurse -Force; Write-Host "Removed your library and settings ($UserDataDir)." }
  # This script lives inside the folder it is deleting, so a moment later a separate command removes the folder.
  if (Test-Path $Prefix) {
    Start-Process -WindowStyle Hidden -FilePath cmd.exe -ArgumentList '/c', "ping -n 3 127.0.0.1 >nul & rmdir /s /q `"$Prefix`""
    Write-Host "Removing $Prefix ..."
  }
  Write-Host 'Flowdeck has been uninstalled.'
  return
}

$src = Join-Path $PSScriptRoot 'Flowdeck'
if (-not (Test-Path (Join-Path $src 'Flowdeck.exe'))) {
  throw "Can't find the Flowdeck folder next to this script ($src). Unzip the whole release first, then run this from there."
}
$version = ''
try { $version = (Get-Content (Join-Path $src 'resources\app\package.json') -Raw | ConvertFrom-Json).version } catch { }

Stop-FlowdeckAt $Prefix
Write-Host "Installing Flowdeck $version to $Prefix ..."
$null = New-Item -ItemType Directory -Force -Path $Prefix
# /MIR makes the folder match the release exactly, so files an older version had and this one doesn't are removed.
& robocopy $src $Prefix /MIR /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -ge 8) { throw "Copying the files failed (robocopy exit code $LASTEXITCODE)." }
Copy-Item -Path $PSCommandPath -Destination (Join-Path $Prefix 'Uninstall-Flowdeck.ps1') -Force

New-Shortcut $startLnk $exe $icon $Prefix
Write-Host "Start-menu shortcut: $startLnk"
if ($DesktopShortcut) { New-Shortcut $desktopLnk $exe $icon $Prefix; Write-Host "Desktop shortcut: $desktopLnk" }

if (-not $NoRegistry) {
  $null = New-Item -Path $RegistryKey -Force
  $kb = [int]((Get-ChildItem $Prefix -Recurse -File | Measure-Object Length -Sum).Sum / 1KB)
  $values = @{
    DisplayName = 'Flowdeck'; DisplayVersion = $version; Publisher = 'Flowdeck'; InstallLocation = $Prefix; DisplayIcon = $icon
    UninstallString = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$(Join-Path $Prefix 'Uninstall-Flowdeck.ps1')`" -Uninstall"
  }
  foreach ($k in $values.Keys) { Set-ItemProperty -Path $RegistryKey -Name $k -Value $values[$k] }
  Set-ItemProperty -Path $RegistryKey -Name EstimatedSize -Value $kb -Type DWord
  Set-ItemProperty -Path $RegistryKey -Name NoModify -Value 1 -Type DWord
  Set-ItemProperty -Path $RegistryKey -Name NoRepair -Value 1 -Type DWord
}

Write-Host 'Done.'
if (-not $NoLaunch) { Start-Process -FilePath $exe -WorkingDirectory $Prefix }
