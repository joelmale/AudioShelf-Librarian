<#
.SYNOPSIS
  Measure how much usable signal your audiobooks' chapter TITLES actually carry.

.DESCRIPTION
  Answers the question R6 in docs/enrichment-sources-review.md depends on and
  never checked: what fraction of this library has chapter titles that are
  something other than "Chapter 1 ... Chapter N"?

  R6 proposes fetching chapter listings from Audnexus to mine POV-character
  names (a cast list for the indie books Wikidata misses) and structure markers
  like "Part One:" / "Interlude". Both payoffs are worthless on a book whose
  chapters are bare numbers. Audiobookshelf already parses chapter metadata out
  of the audio files, so the distribution can be measured locally, for free,
  before committing to a new provider and its per-book request cost.

  Read-only. Talks only to your own Audiobookshelf instance. Writes nothing
  back, and touches neither curator.db nor any enrichment provider.

.EXAMPLE
  .\scripts\measure-chapter-signal.ps1 -AbsUrl https://abs.example.com -AbsToken abc123

.EXAMPLE
  .\scripts\measure-chapter-signal.ps1 -AbsUrl https://abs.example.com -AbsToken abc123 -Sample 80 -ShowHits
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string] $AbsUrl,
  [Parameter(Mandatory = $true)][string] $AbsToken,
  [int] $Sample = 150,
  [string] $LibraryId,
  [switch] $ShowHits,
  [string] $CsvPath
)

$ErrorActionPreference = 'Stop'
$base = $AbsUrl.TrimEnd('/')
$headers = @{ Authorization = "Bearer $AbsToken" }

function Get-Abs {
  param([string] $Path)
  return Invoke-RestMethod -Uri ($base + $Path) -Headers $headers -Method Get
}

# A title carries no information if it is just an index ("Chapter 12", "12",
# "Chapter Twelve") or front/back matter the publisher adds to every book.
$numberWords = 'one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty'
$bareIndex   = '^\s*(chapter|ch\.?|track|section)?\s*(\d+|[ivxlc]+|(' + $numberWords + ')([\s-]+(' + $numberWords + '))*)\s*$'
$boilerplate = '^\s*(opening|end)\s+credits\s*$|^\s*(dedication|acknowledgments|acknowledgements|about the author|copyright|title page|foreword|preface|introduction|afterword|epigraph|contents)\s*$'
# Structure markers are a real R6 payoff on their own and need no name-gating.
$structure   = '^\s*(part|book|volume|act|interlude|prologue|epilogue)\b'

function Classify {
  param([string] $Title)
  if ([string]::IsNullOrWhiteSpace($Title)) { return 'empty' }
  if ($Title -match $boilerplate) { return 'boilerplate' }
  if ($Title -match $structure)   { return 'structure' }
  if ($Title -match $bareIndex)   { return 'bare' }
  return 'named'
}

Write-Host "Connecting to $base ..." -ForegroundColor Cyan
try {
  $libs = Get-Abs '/api/libraries'
} catch {
  Write-Host "Could not reach Audiobookshelf: $($_.Exception.Message)" -ForegroundColor Red
  Write-Host "Check the URL (include https://) and that the token is a valid API token." -ForegroundColor Red
  exit 1
}

$bookLibs = @($libs.libraries | Where-Object { $_.mediaType -eq 'book' })
if ($bookLibs.Count -eq 0) { Write-Host "No book libraries found." -ForegroundColor Red; exit 1 }
if ($LibraryId) {
  $lib = $bookLibs | Where-Object { $_.id -eq $LibraryId } | Select-Object -First 1
} else {
  $lib = $bookLibs[0]
}
if (-not $lib) { Write-Host "Library '$LibraryId' not found." -ForegroundColor Red; exit 1 }
Write-Host ("Library: {0} ({1})" -f $lib.name, $lib.id)

$items = @((Get-Abs ("/api/libraries/{0}/items?limit=0" -f $lib.id)).results)
if ($items.Count -eq 0) { Write-Host "Library returned no items." -ForegroundColor Red; exit 1 }
$total = $items.Count
if ($Sample -gt 0 -and $Sample -lt $total) {
  # Deterministic spread across the library rather than the alphabetical head,
  # so the sample is not all one author or series.
  $step = [Math]::Floor($total / $Sample)
  if ($step -lt 1) { $step = 1 }
  $picked = New-Object System.Collections.ArrayList
  for ($k = 0; $k -lt $total -and $picked.Count -lt $Sample; $k += $step) { $null = $picked.Add($items[$k]) }
  $items = @($picked)
}
Write-Host ("Inspecting {0} of {1} books" -f $items.Count, $total)
Write-Host ""

$rows = New-Object System.Collections.ArrayList
$noChapterData = 0
$failed = 0
$i = 0
foreach ($it in $items) {
  $i++
  Write-Progress -Activity 'Reading chapters' -Status ("{0}/{1}" -f $i, $items.Count) -PercentComplete (100 * $i / $items.Count)
  try {
    $full = Get-Abs ("/api/items/{0}?expanded=1" -f $it.id)
  } catch {
    $failed++
    continue
  }

  $chapters = @($full.media.chapters)
  if ($chapters.Count -eq 0) { $noChapterData++; continue }

  $named = 0
  $struct = 0
  $examples = New-Object System.Collections.ArrayList
  foreach ($c in $chapters) {
    $kind = Classify $c.title
    if ($kind -eq 'named') {
      $named++
      if ($examples.Count -lt 3) { $null = $examples.Add($c.title) }
    } elseif ($kind -eq 'structure') {
      $struct++
    }
  }

  $null = $rows.Add([pscustomobject]@{
    Title        = $full.media.metadata.title
    Chapters     = $chapters.Count
    Named        = $named
    Structure    = $struct
    HasNamed     = ($named -gt 0)
    HasStructure = ($struct -gt 0)
    Examples     = ($examples -join ' | ')
  })
}
Write-Progress -Activity 'Reading chapters' -Completed

$withData = $rows.Count
Write-Host "================ CHAPTER TITLE SIGNAL ================" -ForegroundColor Cyan
Write-Host ("books inspected          : {0}" -f $items.Count)
Write-Host ("  no chapter data in ABS : {0}" -f $noChapterData)
Write-Host ("  request failed         : {0}" -f $failed)
Write-Host ("  with chapter data      : {0}" -f $withData)
if ($withData -eq 0) {
  Write-Host ""
  Write-Host "ABS carries no chapter titles for this sample, so it cannot answer the" -ForegroundColor Yellow
  Write-Host "R6 question locally. Audnexus would be the only source." -ForegroundColor Yellow
  exit 0
}

$hitsNamed  = @($rows | Where-Object { $_.HasNamed }).Count
$hitsStruct = @($rows | Where-Object { $_.HasStructure }).Count
$pctNamed   = [Math]::Round(100 * $hitsNamed / $withData, 1)
$pctStruct  = [Math]::Round(100 * $hitsStruct / $withData, 1)
Write-Host ""
Write-Host ("books with >=1 NAMED chapter     : {0} / {1}  ({2}%)   <- R6 cast-list payoff" -f $hitsNamed, $withData, $pctNamed)
Write-Host ("books with >=1 STRUCTURE marker  : {0} / {1}  ({2}%)   <- R6 structure-tag payoff" -f $hitsStruct, $withData, $pctStruct)
Write-Host ""
if ($pctNamed -lt 10) {
  Write-Host "VERDICT: below 10% - R6's character-name payoff does not justify a new" -ForegroundColor Yellow
  Write-Host "provider on this library. Record the number in the review doc and park it." -ForegroundColor Yellow
} else {
  Write-Host "VERDICT: R6's cast-list payoff looks real here. Worth building, still gated" -ForegroundColor Green
  Write-Host "so a chapter-title name must be corroborated before entering book_entities." -ForegroundColor Green
}

if ($ShowHits) {
  Write-Host ""
  Write-Host "Books with named chapters:" -ForegroundColor Cyan
  $rows | Where-Object { $_.HasNamed } | Sort-Object -Property Named -Descending |
    Select-Object Title, Chapters, Named, Examples | Format-Table -AutoSize -Wrap
}
if ($CsvPath) {
  $rows | Export-Csv -LiteralPath $CsvPath -NoTypeInformation -Encoding UTF8
  Write-Host ""
  Write-Host "Per-book detail written to $CsvPath"
}
