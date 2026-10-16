#!/bin/bash
i=0
while IFS= read -r q; do
  i=$((i+1))
  out=$(mcporter call exa.web_search_exa query="$q" numResults=8 2>&1)
  printf 'QUERY: %s\n%s\n' "$q" "$out" > "exa_$(printf %02d $i).txt"
done <<'Q'
best instagram reels accounts engineering 3D animation how things work millions of views
tiktok engineering explainer accounts 3D animation mechanisms viral how it works
viral engineering explainer reels hook formula first 3 seconds retention 2026
most viewed 3D animation how it works shorts channels mechanical engineering
short form educational video virality what drives shares saves 2026 study
how much water does AI use per query data center estimate source 2026
instagram reels vs tiktok vs youtube shorts length and format differences 2026 educational content
Q
echo finished > exa_done.txt
