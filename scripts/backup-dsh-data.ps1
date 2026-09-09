param(
  [Parameter(Mandatory = $true)] [string]$Source,
  [Parameter(Mandatory = $true)] [string]$Destination
)

$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force -Path $Destination | Out-Null
if (-not (Test-Path -LiteralPath $Source)) { exit 0 }

foreach ($name in @('settings.yaml', '.credentials.yaml', '.anonymous-user-id')) {
  $path = Join-Path $Source $name
  if (Test-Path -LiteralPath $path) {
    Copy-Item -LiteralPath $path -Destination (Join-Path $Destination $name) -Force
  }
}

foreach ($name in @('sessions', 'storages')) {
  $path = Join-Path $Source $name
  if (Test-Path -LiteralPath $path) {
    Copy-Item -LiteralPath $path -Destination (Join-Path $Destination $name) -Recurse -Force
  }
}

$profiles = Join-Path $Source 'profiles'
if (Test-Path -LiteralPath $profiles) {
  $profileDestination = Join-Path $Destination 'profiles'
  New-Item -ItemType Directory -Force -Path $profileDestination | Out-Null
  Get-ChildItem -LiteralPath $profiles -Force | Where-Object Name -ne 'node_modules' |
    Copy-Item -Destination $profileDestination -Recurse -Force
}
