import fs from 'node:fs';
const s = JSON.parse(fs.readFileSync('channels.json', 'utf-8'));
const med = (a) => { const b = [...a].sort((x, y) => x - y); return b.length ? b[Math.floor(b.length / 2)] : 0; };
const f = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? Math.round(n / 1e3) + 'k' : String(n));
const chans = [];
const outliers = [];
for (const [id, c] of Object.entries(s.shorts)) {
  const v = c.shorts.filter((x) => x.views != null);
  if (v.length < 10) continue;
  const m = med(v.map((x) => x.views));
  const recent = v.slice(0, 20);
  const mRecent = med(recent.map((x) => x.views));
  chans.push({ id, name: c.name, subs: c.subs, n: v.length, median: m, medianRecent20: mRecent, recentPerSub: c.subs ? mRecent / c.subs : 0, query: c.query });
  for (const x of v) if (m > 0 && x.views >= 3 * m && x.views >= 50_000) outliers.push({ ch: c.name, subs: c.subs, chMedian: m, views: x.views, ratio: +(x.views / m).toFixed(1), title: x.title, id: x.id });
}
chans.sort((a, b) => b.recentPerSub - a.recentPerSub);
console.log('CHANNELS ranked by recent median views / subscriber (algorithmic pull beyond own audience)');
console.log('name'.padEnd(34), 'subs'.padStart(7), 'medAll'.padStart(7), 'medRec'.padStart(7), 'rec/sub');
for (const c of chans) console.log(c.name.slice(0, 33).padEnd(34), f(c.subs).padStart(7), f(c.median).padStart(7), f(c.medianRecent20).padStart(7), c.recentPerSub.toFixed(2).padStart(7), ' ', c.query);
outliers.sort((a, b) => b.ratio - a.ratio);
fs.writeFileSync('outliers.json', JSON.stringify({ chans, outliers }, null, 1));
console.log(`\nOUTLIERS (>=3x channel median, >=50k views): ${outliers.length}`);
for (const o of outliers.slice(0, 120)) console.log(`${String(o.ratio).padStart(6)}x ${f(o.views).padStart(6)} [${o.ch.slice(0, 22)} ${f(o.subs)}] ${o.title?.slice(0, 95)}`);
