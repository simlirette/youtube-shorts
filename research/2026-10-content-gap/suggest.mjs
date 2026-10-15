// YouTube autocomplete demand mining (public suggest endpoint, ds=yt). Expands seed + a..z.
import fs from 'node:fs';
const SEEDS = ['why did', 'what happened to', 'how did', 'why do planes', 'why are', 'the real reason', 'what if', 'why is it illegal to', 'how was', 'who invented', 'why does', 'what really happened'];
const letters = ' abcdefghijklmnopqrstuvwxyz'.split('');
const out = {};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (const seed of SEEDS) {
  const set = new Map();
  for (const l of letters) {
    const q = l === ' ' ? seed : `${seed} ${l}`;
    try {
      const r = await fetch(`https://suggestqueries.google.com/complete/search?client=firefox&ds=yt&q=${encodeURIComponent(q)}`);
      const j = JSON.parse(await r.text());
      j[1].forEach((s, i) => { if (!set.has(s)) set.set(s, i); });
    } catch {}
    await sleep(120);
  }
  out[seed] = [...set.keys()];
  console.log(seed, out[seed].length);
}
fs.writeFileSync('suggest.json', JSON.stringify(out, null, 1));
