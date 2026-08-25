# NexusInfra installer for Windows (#191).
#
# The PowerShell counterpart of install.sh — same questions, same result. Windows
# is a first-class target here: the panel is commonly self-hosted on a desktop
# running Docker Desktop.
#
# Safe to re-run: an existing .env is never overwritten without being asked.
#
#   powershell -ExecutionPolicy Bypass -File install.ps1

param([ValidateSet('community', 'hosted')][string]$Edition)

$ErrorActionPreference = 'Stop'
Set-Location -Path $PSScriptRoot

function Write-Bold($m) { Write-Host $m -ForegroundColor White }
function Write-Warn($m) { Write-Host $m -ForegroundColor Yellow }
function Die($m) { Write-Host $m -ForegroundColor Red; exit 1 }

Write-Bold 'NexusInfra installer'
Write-Host ''

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
  Die 'Docker is required but was not found. Install Docker Desktop, then run this again.'
}
docker compose version *> $null
if ($LASTEXITCODE -ne 0) { Die "This needs Docker Compose v2 ('docker compose'). Update Docker Desktop, then run this again." }

# ── Which edition ────────────────────────────────────────────────────────────
if (-not $Edition) {
  Write-Host 'Which edition would you like to run?'
  Write-Host ''
  Write-Host '  1) community  - self-hosted panel for your own machines. No billing.'
  Write-Host '  2) hosted     - multi-tenant, with usage billing through FinVault.'
  Write-Host ''
  switch ((Read-Host 'Choose [1]')) {
    '2'         { $Edition = 'hosted' }
    'hosted'    { $Edition = 'hosted' }
    default     { $Edition = 'community' }
  }
}
if (-not (Test-Path $Edition)) { Die "No bundle for '$Edition' in this archive." }

Write-Host ''
Write-Bold "Setting up the $Edition edition"
Set-Location $Edition

# A weak secret here is not cosmetic: JWT_SECRET mints tokens for any account,
# and INTERNAL_API_TOKEN reaches an API that can start containers.
function New-Secret {
  $bytes = New-Object 'System.Byte[]' 32
  [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  ($bytes | ForEach-Object { $_.ToString('x2') }) -join ''
}

$skipEnv = $false
if (Test-Path '.env') {
  Write-Warn 'A .env already exists here.'
  if ((Read-Host 'Keep it and skip configuration? [Y/n]') -match '^[Nn]') {
    Move-Item '.env' ".env.backup.$(Get-Date -Format 'yyyyMMddHHmmss')"
    Write-Host 'Previous .env kept as a .env.backup.* file.'
  } else {
    Write-Host 'Keeping the existing .env.'
    $skipEnv = $true
  }
}

$adminEmail = 'the address in .env'
if (-not $skipEnv) {
  $adminEmail = Read-Host 'Administrator email [admin@local]'
  if (-not $adminEmail) { $adminEmail = 'admin@local' }

  $adminPassword = $null
  while (-not $adminPassword) {
    $secure = Read-Host 'Administrator password (leave blank to generate one)' -AsSecureString
    $plain = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
      [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure))
    if (-not $plain) {
      $adminPassword = (New-Secret).Substring(0, 20)
      Write-Host 'Generated a password - it is written to .env, keep it safe.'
      break
    }
    $secure2 = Read-Host 'Confirm password' -AsSecureString
    $plain2 = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
      [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure2))
    if ($plain -ceq $plain2) { $adminPassword = $plain } else { Write-Warn 'Those did not match, try again.' }
  }

  Copy-Item '.env.example' '.env' -Force
  $env_ = Get-Content '.env'
  function Set-Var($lines, $key, $value) { $lines -replace "^$key=.*", "$key=$value" }

  $env_ = Set-Var $env_ 'ADMIN_EMAIL' $adminEmail
  $env_ = Set-Var $env_ 'ADMIN_PASSWORD' $adminPassword
  $env_ = Set-Var $env_ 'JWT_SECRET' (New-Secret)
  $env_ = Set-Var $env_ 'INTERNAL_API_TOKEN' (New-Secret)

  if ($Edition -eq 'hosted') {
    Write-Host ''
    Write-Warn 'The hosted edition exchanges payment events with FinVault.'
    Write-Warn "FINVAULT_MESSAGE_KEY must be identical on both sides or neither can read the other's events."
    $key = Read-Host 'FinVault message key (blank to fill in later)'
    if ($key) { $env_ = Set-Var $env_ 'FINVAULT_MESSAGE_KEY' $key }
    else { Write-Warn "Left blank - set FINVAULT_MESSAGE_KEY in $Edition\.env before starting." }
  }

  Set-Content '.env' $env_
  Write-Host ''
  Write-Host "Wrote $Edition\.env with generated secrets."
}

Write-Host ''
if ((Read-Host 'Start NexusInfra now? [Y/n]') -match '^[Nn]') {
  Write-Host ''
  Write-Host 'Not started. When you are ready:'
  Write-Host "  cd $Edition; docker compose up -d"
  exit 0
}

Write-Host ''
Write-Host 'Pulling images and starting...'
docker compose pull
docker compose up -d

$port = (Select-String -Path '.env' -Pattern '^DASHBOARD_PORT=(.*)$').Matches.Groups[1].Value
if (-not $port) { $port = '8095' }

Write-Host ''
Write-Bold 'NexusInfra is running.'
Write-Host "  Panel:  http://localhost:$port"
Write-Host "  Sign in as: $adminEmail"
Write-Host ''
Write-Host "  Logs:   cd $Edition; docker compose logs -f"
Write-Host "  Stop:   cd $Edition; docker compose down"
