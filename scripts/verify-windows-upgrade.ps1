param(
  [Parameter(Mandatory = $true)]
  [string]$PreviousInstaller,

  [Parameter(Mandatory = $true)]
  [string]$CurrentInstaller,

  [switch]$AllowUnsigned,
  [switch]$KeepArtifacts
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if ($env:FORGE_CLEAN_VM -ne "1") {
  throw "This script installs and uninstalls Forge. Run it only in a clean Windows VM with FORGE_CLEAN_VM=1."
}

function Resolve-Installer([string]$Value, [string]$Label) {
  $resolved = (Resolve-Path -LiteralPath $Value).Path
  if ([IO.Path]::GetExtension($resolved) -ne ".exe") { throw "$Label must be an .exe installer." }
  return $resolved
}

function Assert-TestDirectory([string]$Value, [string]$ExpectedLeaf) {
  $base = [IO.Path]::GetFullPath($env:LOCALAPPDATA).TrimEnd("\") + "\"
  $target = [IO.Path]::GetFullPath($Value)
  if (-not $target.StartsWith($base, [StringComparison]::OrdinalIgnoreCase) -or (Split-Path -Leaf $target) -ne $ExpectedLeaf) {
    throw "Unsafe test directory: $target"
  }
  return $target
}

function Assert-Signature([string]$Installer, [string]$Label) {
  $status = (Get-AuthenticodeSignature -LiteralPath $Installer).Status.ToString()
  if ($status -eq "Valid") { return }
  if ($AllowUnsigned -and $status -eq "NotSigned") {
    Write-Warning "$Label is unsigned; allowed only for this internal VM run."
    return
  }
  throw "$Label signature is $status. Use a valid signature for commercial verification."
}

function Run-Process([string]$FilePath, [string[]]$Arguments) {
  $process = Start-Process -FilePath $FilePath -ArgumentList $Arguments -Wait -PassThru -WindowStyle Hidden
  if ($process.ExitCode -ne 0) { throw "$FilePath failed with exit code $($process.ExitCode)." }
}

function Run-ForgeSmoke([string]$Executable, [string]$DataDirectory) {
  $oldSmoke = [Environment]::GetEnvironmentVariable("FORGE_SMOKE_TEST", "Process")
  $oldData = [Environment]::GetEnvironmentVariable("FORGE_SMOKE_USER_DATA_DIR", "Process")
  try {
    $env:FORGE_SMOKE_TEST = "1"
    $env:FORGE_SMOKE_USER_DATA_DIR = $DataDirectory
    Run-Process $Executable @()
  } finally {
    if ($null -eq $oldSmoke) { Remove-Item Env:FORGE_SMOKE_TEST -ErrorAction SilentlyContinue } else { $env:FORGE_SMOKE_TEST = $oldSmoke }
    if ($null -eq $oldData) { Remove-Item Env:FORGE_SMOKE_USER_DATA_DIR -ErrorAction SilentlyContinue } else { $env:FORGE_SMOKE_USER_DATA_DIR = $oldData }
  }
}

$previous = Resolve-Installer $PreviousInstaller "PreviousInstaller"
$current = Resolve-Installer $CurrentInstaller "CurrentInstaller"
if ($previous -eq $current) { throw "PreviousInstaller and CurrentInstaller must be different files." }
Assert-Signature $previous "Previous installer"
Assert-Signature $current "Current installer"

$installDirectory = Assert-TestDirectory (Join-Path $env:LOCALAPPDATA "ForgeUpgradeVerification") "ForgeUpgradeVerification"
$dataDirectory = Assert-TestDirectory (Join-Path $env:LOCALAPPDATA "ForgeUpgradeVerificationData") "ForgeUpgradeVerificationData"
$forgeExecutable = Join-Path $installDirectory "Forge.exe"
$uninstaller = Join-Path $installDirectory "Uninstall Forge.exe"
$sentinel = Join-Path $dataDirectory "upgrade-sentinel.json"

if ((Test-Path -LiteralPath $installDirectory) -or (Test-Path -LiteralPath $dataDirectory)) {
  throw "Upgrade verification directories already exist. Remove them only after confirming they belong to a previous test run."
}

Write-Output "[1/6] Installing previous Forge release"
Run-Process $previous @("/S", "/D=$installDirectory")
if (-not (Test-Path -LiteralPath $forgeExecutable)) { throw "Previous Forge executable was not installed." }

Write-Output "[2/6] Starting previous release in isolated smoke mode"
New-Item -ItemType Directory -Path $dataDirectory | Out-Null
'{"createdBy":"Forge upgrade verification"}' | Set-Content -LiteralPath $sentinel -Encoding UTF8
Run-ForgeSmoke $forgeExecutable $dataDirectory

Write-Output "[3/6] Installing current release over the previous release"
Run-Process $current @("/S", "/D=$installDirectory")
if (-not (Test-Path -LiteralPath $forgeExecutable)) { throw "Current Forge executable is missing after upgrade." }
$expectedVersion = (Get-Item -LiteralPath $current).VersionInfo.ProductVersion
$installedVersion = (Get-Item -LiteralPath $forgeExecutable).VersionInfo.ProductVersion
if ($installedVersion -ne $expectedVersion) { throw "Installed version $installedVersion does not match installer version $expectedVersion." }
if (-not (Test-Path -LiteralPath $sentinel)) { throw "User data was removed during the upgrade." }

Write-Output "[4/6] Starting upgraded release in isolated smoke mode"
Run-ForgeSmoke $forgeExecutable $dataDirectory

Write-Output "[5/6] Uninstalling the upgraded release"
if (-not (Test-Path -LiteralPath $uninstaller)) { throw "Forge uninstaller was not found." }
Run-Process $uninstaller @("/S")
if (Test-Path -LiteralPath $forgeExecutable) { throw "Forge executable remains after uninstall." }
if (-not (Test-Path -LiteralPath $sentinel)) { throw "Uninstall unexpectedly removed user data." }

Write-Output "[6/6] Verification passed"
if (-not $KeepArtifacts) {
  if (Test-Path -LiteralPath $installDirectory) { Remove-Item -LiteralPath $installDirectory -Recurse -Force }
  if (Test-Path -LiteralPath $dataDirectory) { Remove-Item -LiteralPath $dataDirectory -Recurse -Force }
}
Write-Output "Forge clean-VM install, upgrade, smoke, uninstall, and data-retention verification passed."
