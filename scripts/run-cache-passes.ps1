<#
.SYNOPSIS
  Run the three cache-only enrichment passes in order, then the re-embed.

.DESCRIPTION
  R1 (promote cached subjects), R2 (backfill descriptions) and R3 (backfill
  narrators) each re-read provider payloads already sitting in
  `external_metadata` and write a derived field. None of them fetches anything:
  no network call to a provider, no quota spent, no rate limit to hit. That is
  why they are safe to re-run - a second run recomputes the same answer from
  the same cache and writes nothing new.

  Order matters, but only with respect to embeddings. R1 never touches book
  card text. R2 and R3 both do, and changed card text is what queues a book for
  re-embedding. Running the embedding pass last therefore folds everything into
  one incremental re-embed instead of three.

  Defaults to a DRY RUN of all four stages: every pass plans its full work and
  writes nothing. Add -Execute to actually write.

.EXAMPLE
  # See what all four stages would do. Changes nothing.
  .\scripts\run-cache-passes.ps1 -BaseUrl https://audioshelf.home.reach-back.net

.EXAMPLE
  # Do it for real.
  .\scripts\run-cache-passes.ps1 -BaseUrl https://audioshelf.home.reach-back.net -Execute

.EXAMPLE
  # Run the three passes but leave embedding for later.
  .\scripts\run-cache-passes.ps1 -BaseUrl https://... -Execute -SkipEmbeddings
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string] $BaseUrl,
  # Without this, every stage runs as a dry run and nothing is written.
  [switch] $Execute,
  [switch] $SkipEmbeddings,
  # Give up waiting on a single stage after this long. The stage keeps running
  # server-side; only this script stops watching.
  [int] $TimeoutMinutes = 90
)

$ErrorActionPreference = 'Stop'
$base = $BaseUrl.TrimEnd('/')
$dryRun = -not $Execute

# Auth is off by default in this app (AUTH_ENABLED=false), so no header is
# sent. If you have turned it on, add -Headers to the two calls below.
function Invoke-Pass {
  param([string] $Name, [string] $Path, [string] $Explain, [string[]] $Fields)

  Write-Host ""
  Write-Host ("=== {0} ===" -f $Name) -ForegroundColor Cyan
  Write-Host $Explain -ForegroundColor DarkGray

  $body = @{ dryRun = $dryRun } | ConvertTo-Json -Compress
  try {
    $start = Invoke-RestMethod -Method Post -Uri ($base + $Path) -ContentType 'application/json' -Body $body
  } catch {
    Write-Host ("  FAILED to start: {0}" -f $_.Exception.Message) -ForegroundColor Red
    if ($_.Exception.Response -and $_.Exception.Response.StatusCode.value__ -eq 404) {
      Write-Host "  A 404 means the running image predates this route - deploy first." -ForegroundColor Red
    }
    return $null
  }

  $opId = $start.operationId
  Write-Host ("  operation {0} ({1})" -f $opId, $(if ($dryRun) { 'dry run' } else { 'writing' }))

  $deadline = (Get-Date).AddMinutes($TimeoutMinutes)
  $lastSeen = ''
  while ($true) {
    Start-Sleep -Seconds 2
    try {
      $op = Invoke-RestMethod -Uri ("{0}/api/operations/{1}" -f $base, $opId)
    } catch {
      Write-Host ("  lost track of the operation: {0}" -f $_.Exception.Message) -ForegroundColor Yellow
      return $null
    }

    if ($op.progress -and $op.progress.total -gt 0) {
      $line = "  {0} of {1}" -f $op.progress.current, $op.progress.total
      if ($line -ne $lastSeen) { Write-Host -NoNewline "`r$line          "; $lastSeen = $line }
    }
    if ($op.status -in @('completed', 'cancelled', 'error')) { Write-Host ""; break }
    if ((Get-Date) -gt $deadline) {
      Write-Host ""
      Write-Host ("  still running after {0} min - leaving it to finish server-side." -f $TimeoutMinutes) -ForegroundColor Yellow
      return $null
    }
  }

  if ($op.status -ne 'completed') {
    $msg = if ($op.error -is [string]) { $op.error } elseif ($op.error) { $op.error.message } else { $op.status }
    Write-Host ("  {0}: {1}" -f $op.status, $msg) -ForegroundColor Red
    return $op
  }

  # Each pass reports different counters; print whichever of the interesting
  # ones this run actually returned.
  $summary = $op.summary
  $parts = @()
  foreach ($f in $Fields) {
    if ($summary -and $null -ne $summary.$f) { $parts += ("{0} {1}" -f $summary.$f, $f) }
  }
  if ($parts.Count -gt 0) { Write-Host ("  " + ($parts -join '  |  ')) -ForegroundColor Green }
  else { Write-Host "  completed (no counters reported)" -ForegroundColor Green }

  if ($summary -and $summary.failed -gt 0) {
    Write-Host ("  {0} book(s) failed and were skipped - the pass continued." -f $summary.failed) -ForegroundColor Yellow
  }
  return $op
}

Write-Host ("Target: {0}" -f $base)
if ($dryRun) {
  Write-Host "MODE: dry run - every stage plans its work and writes nothing. Add -Execute to write." -ForegroundColor Yellow
} else {
  Write-Host "MODE: EXECUTE - this writes to the database." -ForegroundColor Green
}

$r1 = Invoke-Pass -Name '1/4  Promote cached subjects (R1)' -Path '/api/enrichment/subjects' `
  -Explain 'Files unrecognised provider subject terms into the vocabulary promotion queue. Does not touch card text.' `
  -Fields @('booksScanned', 'termsProposed', 'termsAlreadyKnown', 'termsPruned', 'failed')

$r2 = Invoke-Pass -Name '2/4  Backfill descriptions (R2)' -Path '/api/enrichment/backfill-descriptions' `
  -Explain 'Fills books with no Audiobookshelf description from a cached provider one. Your own descriptions are never overwritten.' `
  -Fields @('booksScanned', 'descriptionsWritten', 'descriptionsCleared', 'cardTextChanged', 'failed')

$r3 = Invoke-Pass -Name '3/4  Backfill narrators (R3)' -Path '/api/enrichment/narrator-backfill' `
  -Explain 'Fills empty narrator fields from cached Audnexus narrator lists. Fills absences only.' `
  -Fields @('booksScanned', 'rowsWithNarrators', 'booksChanged', 'failed')

if ($SkipEmbeddings) {
  Write-Host ""
  Write-Host "Skipping the embedding pass (-SkipEmbeddings)." -ForegroundColor Yellow
  Write-Host "Run it later, or stages 2 and 3's card changes stay un-embedded." -ForegroundColor Yellow
} else {
  $r4 = Invoke-Pass -Name '4/4  Re-embed changed cards' -Path '/api/embeddings/run' `
    -Explain 'Re-embeds only books whose card text changed. Everything else is skipped for free.' `
    -Fields @('embedded', 'unchanged', 'skipped', 'failed')
}

Write-Host ""
if ($dryRun) {
  Write-Host "Dry run complete. Nothing was written." -ForegroundColor Cyan
  Write-Host "Re-run with -Execute to apply." -ForegroundColor Cyan
} else {
  Write-Host "Done." -ForegroundColor Cyan
  Write-Host "Check coverage with: Invoke-RestMethod -Uri '$base/api/embeddings/coverage'" -ForegroundColor DarkGray
}
