$queries = @(
  'YouTube Partner Program inauthentic content mass-produced repetitive policy AI voiceover Shorts monetization',
  'YouTube Shorts optimal length retention data study 2026 swipe away rate',
  'YouTube Shorts algorithm 2026 what changed viewed vs swiped away metric',
  'AI generated faceless shorts saturation 2026 audience fatigue AI slop facts channels',
  'documentary style YouTube Shorts channel growth case study fact checked sources',
  'underserved YouTube Shorts topics high search demand low supply analysis',
  'YouTube Shorts RPM by niche 2026 history science education',
  'Shorts series format episodic part 1 part 2 retention subscribers conversion'
)
$i = 0
foreach ($q in $queries) {
  $i++
  $out = mcporter call exa.web_search_exa query="$q" numResults=6 2>&1 | Out-String
  Set-Content -Path ("exa_{0:D2}.txt" -f $i) -Value ("QUERY: $q`n" + $out) -Encoding utf8
  Write-Output ("{0}: {1} chars" -f $i, $out.Length)
}
