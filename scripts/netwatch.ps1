# Network monitor for PrepPulse (Windows PowerShell 5.1 or later, no installs).
#
# Polls the TCP connections of this project's Electron processes once a second
# and logs each distinct remote address and port: reverse-DNS name (best effort),
# first seen, last seen. Connection metadata only, no packet contents.
#
# Output: data/diagnostics/netwatch-<timestamp>.csv (rewritten whenever something changes).
# Stops on Ctrl+C, or by itself 10 seconds after the app's processes have all exited.
#
# Run (start it before the app):
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\netwatch.ps1
#
# Limits: TCP only (Get-NetTCPConnection); UDP, including DNS lookups made by the
# Windows DNS client on the app's behalf, is not visible here. A connection that
# opens and closes within one poll can be missed.

param(
  [int]$IntervalMs = 1000,
  [int]$ExitAfterIdleSeconds = 10
)

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$electronDir = Join-Path $root 'node_modules\electron\dist'
$outDir = Join-Path $root 'data\diagnostics'
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
$stamp = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH-mm-ssZ')
$outFile = Join-Path $outDir "netwatch-$stamp.csv"

$seen = @{}   # "address|port" -> row
$dns = @{}    # address -> hostname
$sawApp = $false
$idleSince = $null

function Get-AppPids {
  Get-Process -Name electron -ErrorAction SilentlyContinue |
    Where-Object { $_.Path -and $_.Path.StartsWith($electronDir, [System.StringComparison]::OrdinalIgnoreCase) } |
    ForEach-Object { $_.Id }
}

function Resolve-Name([string]$address) {
  if ($dns.ContainsKey($address)) { return $dns[$address] }
  $name = ''
  try {
    $r = Resolve-DnsName -Name $address -Type PTR -DnsOnly -QuickTimeout -ErrorAction Stop | Where-Object { $_.NameHost } | Select-Object -First 1
    if ($r) { $name = $r.NameHost }
  } catch { $name = '' }
  $dns[$address] = $name
  return $name
}

function Save-Csv {
  if ($seen.Count -eq 0) { Set-Content -Encoding UTF8 -Path $outFile -Value '"RemoteAddress","RemotePort","Hostname","States","Pids","FirstSeen","LastSeen","Polls"'; return }
  $seen.Values | Sort-Object FirstSeen | Select-Object RemoteAddress, RemotePort, Hostname, States, Pids, FirstSeen, LastSeen, Polls |
    Export-Csv -NoTypeInformation -Encoding UTF8 -Path $outFile
}

Write-Host "netwatch: watching Electron processes under $electronDir"
Write-Host "netwatch: writing $outFile (Ctrl+C to stop)"

try {
  while ($true) {
    $pids = @(Get-AppPids)
    if ($pids.Count -gt 0) {
      $sawApp = $true
      $idleSince = $null
      $now = (Get-Date).ToString('o')
      $changed = $false
      $conns = Get-NetTCPConnection -OwningProcess $pids -ErrorAction SilentlyContinue |
        Where-Object { $_.RemoteAddress -notin @('0.0.0.0', '::', '127.0.0.1', '::1') -and $_.RemotePort -ne 0 }
      foreach ($c in $conns) {
        $key = "$($c.RemoteAddress)|$($c.RemotePort)"
        if (-not $seen.ContainsKey($key)) {
          $seen[$key] = [pscustomobject]@{
            RemoteAddress = $c.RemoteAddress; RemotePort = $c.RemotePort; Hostname = (Resolve-Name $c.RemoteAddress)
            States = "$($c.State)"; Pids = "$($c.OwningProcess)"; FirstSeen = $now; LastSeen = $now; Polls = 1
          }
          Write-Host ("netwatch: new {0}:{1} {2}" -f $c.RemoteAddress, $c.RemotePort, $seen[$key].Hostname)
          $changed = $true
        } else {
          $row = $seen[$key]
          if ($row.LastSeen -ne $now) { $row.LastSeen = $now; $row.Polls++ ; $changed = $true }
          if (($row.States -split ';') -notcontains "$($c.State)") { $row.States += ";$($c.State)" }
          if (($row.Pids -split ';') -notcontains "$($c.OwningProcess)") { $row.Pids += ";$($c.OwningProcess)" }
        }
      }
      if ($changed) { Save-Csv }
    } elseif ($sawApp) {
      if (-not $idleSince) { $idleSince = Get-Date }
      if (((Get-Date) - $idleSince).TotalSeconds -ge $ExitAfterIdleSeconds) { Write-Host 'netwatch: the app has exited'; break }
    }
    Start-Sleep -Milliseconds $IntervalMs
  }
} finally {
  Save-Csv
  Write-Host "netwatch: $($seen.Count) distinct remote address and port pairs, saved to $outFile"
}
