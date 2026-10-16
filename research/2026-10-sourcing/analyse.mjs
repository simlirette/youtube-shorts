// Ranks what performs: absolute views and views relative to channel size ("outlier ratio"), by topic area,
// duration band and title pattern. Reads videos.json + channels.json from collect.mjs.
import fs from 'node:fs';
import path from 'node:path';

const OUT = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const videos = JSON.parse(fs.readFileSync(path.join(OUT, 'videos.json'), 'utf8'));
const chans = new Map(JSON.parse(fs.readFileSync(path.join(OUT, 'channels.json'), 'utf8')).map((c) => [c.id, c]));

const rows = videos
  .filter((v) => v.views != null && v.duration != null && v.duration <= 180)
  .map((v) => {
    const subs = chans.get(v.channelId)?.followers ?? null;
    return { ...v, subs, ratio: subs ? v.views / subs : null, short: v.duration <= 60 };
  });

const med = (a) => (a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] : null);
const fmt = (n) => (n == null ? '-' : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? Math.round(n / 1e3) + 'K' : String(n));

const out = [];
const log = (s = '') => { out.push(s); console.log(s); };

log(`# Sourcing analysis (YouTube, public data)\n`);
log(`${videos.length} videos found, ${rows.length} with views and length <= 3 min, ${rows.filter((r) => r.short).length} are <= 60 s.\n`);

log('## Median and top views by topic area (videos <= 3 min)\n');
log('| Area | videos | median views | p90 views | <=60 s median | best |');
log('|---|---|---|---|---|---|');
for (const cat of ['mechanism', 'howthingswork', 'design', 'history', 'ai_computing', 'investigative']) {
  const r = rows.filter((x) => x.categories.includes(cat));
  const views = r.map((x) => x.views).sort((a, b) => a - b);
  const p90 = views[Math.floor(views.length * 0.9)];
  const sh = r.filter((x) => x.short).map((x) => x.views);
  const best = [...r].sort((a, b) => b.views - a.views)[0];
  log(`| ${cat} | ${r.length} | ${fmt(med(views))} | ${fmt(p90)} | ${fmt(med(sh))} | ${fmt(best?.views)} ${best ? best.title.slice(0, 42) : ''} |`);
}

log('\n## Duration bands (all areas)\n');
log('| Length | videos | median views |');
log('|---|---|---|');
for (const [lo, hi] of [[0, 30], [30, 45], [45, 60], [60, 90], [90, 180]]) {
  const r = rows.filter((x) => x.duration > lo && x.duration <= hi).map((x) => x.views);
  log(`| ${lo}-${hi} s | ${r.length} | ${fmt(med(r))} |`);
}

log('\n## Title patterns (median views, videos <= 3 min)\n');
const patterns = {
  'How X works': /\bhow (a |an |the |does |do |is |are )?.{2,40} works?\b/i,
  'Why ...?': /\bwhy\b/i,
  'What if / What happens': /\bwhat (if|happens)\b/i,
  '3D animation in title': /3d|animation|animated/i,
  'Inside / cutaway / cross-section': /\binside\b|cutaway|cross.?section|exploded/i,
  'Number or superlative': /\b\d+\b|\bmost\b|\bbiggest\b|\bimpossible\b|\binsane\b/i,
  'Shorts tag': /#shorts/i,
  'History / who invented': /\bhistory\b|\binvent|\bevolution\b|\borigin/i,
};
log('| Pattern | videos | median views | median ratio (views/subs) |');
log('|---|---|---|---|');
for (const [name, re] of Object.entries(patterns)) {
  const r = rows.filter((x) => re.test(x.title));
  log(`| ${name} | ${r.length} | ${fmt(med(r.map((x) => x.views)))} | ${med(r.filter((x) => x.ratio).map((x) => x.ratio))?.toFixed(2) ?? '-'} |`);
}

log('\n## Top 25 outliers: views relative to channel size (channel >= 5K subs, views >= 100K)\n');
log('| ratio | views | subs | len | channel | title | area |');
log('|---|---|---|---|---|---|---|');
for (const r of rows.filter((x) => x.ratio && x.subs >= 5000 && x.views >= 100_000).sort((a, b) => b.ratio - a.ratio).slice(0, 25)) {
  log(`| ${r.ratio.toFixed(1)}x | ${fmt(r.views)} | ${fmt(r.subs)} | ${Math.round(r.duration)}s | ${r.channel} | ${r.title.slice(0, 70)} | ${r.categories[0]} |`);
}

log('\n## Top 20 by absolute views, <= 60 s\n');
log('| views | len | channel (subs) | title |');
log('|---|---|---|---|');
for (const r of rows.filter((x) => x.short).sort((a, b) => b.views - a.views).slice(0, 20)) {
  log(`| ${fmt(r.views)} | ${Math.round(r.duration)}s | ${r.channel} (${fmt(r.subs)}) | ${r.title.slice(0, 80)} |`);
}

log('\n## Queries with the strongest and weakest demand (median views of the 30 results)\n');
const byQ = new Map();
for (const r of rows) for (const q of r.queries) (byQ.get(q) ?? byQ.set(q, []).get(q)).push(r.views);
const qs = [...byQ.entries()].map(([q, v]) => ({ q, n: v.length, med: med(v), max: Math.max(...v) })).filter((x) => x.n >= 5).sort((a, b) => b.med - a.med);
log('| query | n | median | max |');
log('|---|---|---|---|');
for (const x of [...qs.slice(0, 12), ...qs.slice(-6)]) log(`| ${x.q} | ${x.n} | ${fmt(x.med)} | ${fmt(x.max)} |`);

fs.writeFileSync(path.join(OUT, 'analysis.md'), out.join('\n') + '\n');
fs.writeFileSync(path.join(OUT, 'rows.json'), JSON.stringify(rows, null, 1));
