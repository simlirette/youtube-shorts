import fs from 'node:fs';
const d = JSON.parse(fs.readFileSync('sweep.json', 'utf-8'));
const q = (a, p) => (a.length ? a[Math.min(a.length - 1, Math.floor(p * a.length))] : 0);
const rows = [];
for (const [k, v] of Object.entries(d)) {
  const yr = (v.year?.entries ?? []).filter((e) => e.dur && e.dur <= 65 && e.views != null);
  const mo = (v.month?.entries ?? []).filter((e) => e.dur && e.dur <= 65 && e.views != null);
  const yv = yr.map((e) => e.views).sort((a, b) => a - b);
  const mv = mo.map((e) => e.views).sort((a, b) => a - b);
  const chans = new Set(yr.map((e) => e.chId));
  const byCh = {};
  for (const e of yr) byCh[e.chId] = (byCh[e.chId] ?? 0) + e.views;
  const tot = yv.reduce((a, b) => a + b, 0) || 1;
  const topShare = Math.max(0, ...Object.values(byCh)) / tot;
  rows.push({
    niche: k,
    nYear: yr.length,
    medYear: q(yv, 0.5),
    p75Year: q(yv, 0.75),
    p90Year: q(yv, 0.9),
    hits100k: yv.filter((x) => x >= 100_000).length,
    hits1m: yv.filter((x) => x >= 1_000_000).length,
    chansYear: chans.size,
    topChanShare: Math.round(topShare * 100),
    nMonth: mo.length,
    medMonth: q(mv, 0.5),
    p90Month: q(mv, 0.9),
    hits10kMonth: mv.filter((x) => x >= 10_000).length,
    avgDur: Math.round(yr.reduce((a, e) => a + e.dur, 0) / (yr.length || 1)),
  });
}
rows.sort((a, b) => b.p75Year - a.p75Year);
const f = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? Math.round(n / 1e3) + 'k' : String(n));
console.log('niche'.padEnd(22), 'nY  medY  p75Y  p90Y  ≥100k ≥1M chans top%  | nM medM p90M ≥10kM avgDur');
for (const r of rows)
  console.log(
    r.niche.padEnd(22),
    String(r.nYear).padStart(2), f(r.medYear).padStart(5), f(r.p75Year).padStart(5), f(r.p90Year).padStart(5),
    String(r.hits100k).padStart(5), String(r.hits1m).padStart(3), String(r.chansYear).padStart(5), String(r.topChanShare).padStart(4),
    ' |', String(r.nMonth).padStart(2), f(r.medMonth).padStart(5), f(r.p90Month).padStart(5), String(r.hits10kMonth).padStart(4), String(r.avgDur).padStart(5)
  );
fs.writeFileSync('analysis.json', JSON.stringify(rows, null, 1));
