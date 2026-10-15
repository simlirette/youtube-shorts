// Per-question supply check: who answers real autocomplete questions, how short, how many views.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
const QS = [
  'why do planes never fly over antarctica', 'why do planes avoid tibet', 'why do planes dump fuel before landing', 'why do planes have round windows',
  'why do planes turn after takeoff', 'why are big ships faster than small ships', 'why are cooling towers shaped like that', 'why is it illegal to die in svalbard',
  'why is it illegal to own f1 tires', 'why are giant ships cut into pieces', 'how do ships float', 'why do ships have bulbous bows',
  'why do trains have no seatbelts', 'why are bridges built in arches', 'why are oil rigs not sinking', 'how was burj khalifa built',
  'why do planes leave white streaks', 'why are runways numbered', 'why do cargo ships go so slow', 'why do skyscrapers not fall over',
];
const run = (args) => new Promise((res) => execFile('yt-dlp', args, { maxBuffer: 64 * 1024 * 1024, timeout: 180_000 }, (e, o) => { try { res(e ? null : JSON.parse(o)); } catch { res(null); } }));
const out = {};
let i = 0;
await Promise.all([0, 1, 2].map(async () => {
  while (i < QS.length) {
    const q = QS[i++];
    const j = await run([`ytsearch20:${q}`, '--flat-playlist', '-J']);
    const all = (j?.entries ?? []).map((e) => ({ title: e.title, views: e.view_count ?? 0, dur: e.duration ?? null, ch: e.channel ?? e.uploader }));
    const shorts = all.filter((e) => e.dur && e.dur <= 65);
    out[q] = { shorts, longTop: all.filter((e) => !e.dur || e.dur > 65).sort((a, b) => b.views - a.views).slice(0, 3) };
    console.log(q, shorts.length);
  }
}));
fs.writeFileSync('questions.json', JSON.stringify(out, null, 1));
const f = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? Math.round(n / 1e3) + 'k' : String(n));
for (const [q, r] of Object.entries(out)) {
  const sv = r.shorts.map((s) => s.views).sort((a, b) => b - a);
  console.log(`\n## ${q}\n  shorts in top20: ${r.shorts.length} | best short: ${f(sv[0] ?? 0)} | 2nd: ${f(sv[1] ?? 0)} | long-form top: ${r.longTop.map((l) => f(l.views) + ' ' + (l.ch ?? '').slice(0, 18)).join(', ')}`);
  for (const s of r.shorts.sort((a, b) => b.views - a.views).slice(0, 3)) console.log(`   ${f(s.views).padStart(6)} ${s.dur}s [${(s.ch ?? '').slice(0, 20)}] ${s.title?.slice(0, 80)}`);
}
