// Demand per candidate topic: how many videos exist, how big the hits are, and whether SMALL channels get big views
// (evidence that the topic itself, not the channel, carries the views).
import fs from 'node:fs';
import path from 'node:path';

const OUT = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const rows = JSON.parse(fs.readFileSync(path.join(OUT, 'rows.json'), 'utf8'));
const fmt = (n) => (n == null ? '-' : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? Math.round(n / 1e3) + 'K' : String(n));
const med = (a) => (a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] : null);

const TOPICS = {
  'car engine / piston / valves': /engine|piston|valve|cylinder/i,
  clutch: /clutch/i,
  'transmission / gearbox': /transmission|gearbox|gear ?box/i,
  differential: /differential/i,
  turbocharger: /turbo/i,
  'brakes / ABS': /brake|abs\b/i,
  'AC compressor / refrigerator': /air condition|compressor|refrigerat|fridge/i,
  'steam engine / locomotive': /steam|locomotive/i,
  'locks / keys': /\block\b|\blocks\b|key/i,
  'pumps / hydraulics': /pump|hydraulic/i,
  'jet / turbine': /jet|turbine|turbofan/i,
  'toilet / plumbing': /toilet|flush|plumbing|sewer/i,
  'bike gears': /bicycle|bike|derailleur|chain/i,
  'watch / clock': /watch|clock|escapement/i,
  'battery / electric motor': /battery|electric motor|motor/i,
  'CPU / computer / GPU': /\bcpu\b|computer|\bgpu\b|processor/i,
  'neural network / ChatGPT / AI': /neural|chatgpt|\bgpt\b|\bai\b|machine learning/i,
  'database / vector search': /database|vector|index|sql/i,
  'storage SSD / hard drive': /\bssd\b|hard drive|storage|flash memory/i,
  'wifi / internet': /wifi|wi-fi|internet|router/i,
  'bullet / firearm': /bullet|gun|handgun|firearm/i,
  'airplane design (windows, wings)': /airplane window|airline window|wing|aircraft/i,
  'spare tire / car design': /spare tire|tyre|tire/i,
  'data center water / AI energy': /water|electricity|energy|data ?cent/i,
  'washing machine / appliances': /washing machine|microwave|dishwasher|dryer/i,
};

const out = [];
const log = (s = '') => (out.push(s), console.log(s));
log('| Topic | videos | median | best | >=100K | tiny-channel hits (channel <30K subs, >=300K views) |');
log('|---|---|---|---|---|---|');
const table = [];
for (const [name, re] of Object.entries(TOPICS)) {
  const r = rows.filter((x) => re.test(x.title));
  if (!r.length) continue;
  const tiny = r.filter((x) => x.subs && x.subs < 30_000 && x.views >= 300_000);
  table.push({ name, n: r.length, med: med(r.map((x) => x.views)), best: Math.max(...r.map((x) => x.views)), big: r.filter((x) => x.views >= 100_000).length, tiny: tiny.length, tinyEx: tiny.sort((a, b) => b.views - a.views)[0] });
}
for (const t of table.sort((a, b) => b.tiny - a.tiny || b.med - a.med)) {
  log(`| ${t.name} | ${t.n} | ${fmt(t.med)} | ${fmt(t.best)} | ${t.big} | ${t.tiny}${t.tinyEx ? ` (e.g. ${fmt(t.tinyEx.views)}: ${t.tinyEx.title.slice(0, 38)})` : ''} |`);
}
fs.writeFileSync(path.join(OUT, 'topics.md'), out.join('\n') + '\n');
