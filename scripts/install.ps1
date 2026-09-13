#Requires -Version 5.1
<#
.SYNOPSIS
    Install deepseek-code from the latest GitHub release (no git required).

.DESCRIPTION
    Downloads the .tgz that the release workflow attached to the newest GitHub
    release of the repository and installs it with `npm install -g`.

.EXAMPLE
    ./scripts/install.ps1

.EXAMPLE
    # from anywhere, without cloning first
    irm https://raw.githubusercontent.com/kwlcode/deepseek-code/main/scripts/install.ps1 | iex

.EXAMPLE
    # install a tarball you already downloaded (or a direct URL)
    ./scripts/install.ps1 -Tarball .\deepseek-code-0.1.0.tgz
#>
[CmdletBinding()]
param(
    # owner/repo to pull the release from
    [string] $Repo = 'kwlcode/deepseek-code',

    # A local .tgz, a URL to one, or empty to use the latest release
    [string] $Tarball,

    # Install into the current project instead of globally
    [switch] $Local
)

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$headers = @{ 'User-Agent' = 'deepseek-code-installer' }

function Get-LatestTarball {
    param([string] $Slug)
    Write-Host "Looking up the latest release of $Slug ..."
    try {
        $release = Invoke-RestMethod -Uri "https://api.github.com/repos/$Slug/releases/latest" -Headers $headers
    } catch {
        throw "No published release found for $Slug. Install from git instead: npm install -g github:$Slug"
    }
    $asset = $release.assets | Where-Object { $_.name -like '*.tgz' } | Select-Object -First 1
    if (-not $asset) { throw "Release $($release.tag_name) has no .tgz asset attached." }
    $dest = Join-Path ([System.IO.Path]::GetTempPath()) $asset.name
    Write-Host "Downloading $($asset.name) from $($release.tag_name) ..."
    Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $dest -Headers $headers
    return $dest
}

if (-not $Tarball) {
    $Tarball = Get-LatestTarball $Repo
} elseif ($Tarball -match '^https?://') {
    $dest = Join-Path ([System.IO.Path]::GetTempPath()) ([System.IO.Path]::GetFileName($Tarball))
    Write-Host "Downloading $Tarball ..."
    Invoke-WebRequest -Uri $Tarball -OutFile $dest -Headers $headers
    $Tarball = $dest
} elseif (-not (Test-Path -LiteralPath $Tarball)) {
    throw "No such file: $Tarball"
}

if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
    throw 'npm was not found on PATH. Install Node.js 18.17 or newer first: https://nodejs.org'
}

if ($Local) {
    Write-Host "Installing $Tarball into the current project ..."
    & npm install $Tarball
} else {
    Write-Host "Installing $Tarball globally ..."
    & npm install -g $Tarball
}
if ($LASTEXITCODE -ne 0) { throw "npm install failed with exit code $LASTEXITCODE" }

if (-not $Local) {
    Write-Host ''
    Write-Host 'Installed. Check it with:'
    Write-Host '  deepseek-code doctor'
    Write-Host '  dsc --version'
}
