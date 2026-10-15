// Outlier analysis: discover channels in our space, pull their latest Shorts with view counts.
import { execFile } from 'node:child_process';
import fs from 'node:fs';

const QUERIES = [
  'history shorts', 'micro documentary shorts', 'engineering explained shorts', 'science explained shorts',
  'disaster explained shorts', 'untold history shorts', 'mystery facts shorts', 'space shorts facts',
  'business story shorts', 'how things work shorts', 'aviation shorts history', 'ocean facts shorts',
  'true story shorts documentary', 'invention history shorts', 'psychology facts shorts', 'military history shorts',
];
const run = (args) =>
  new Promise((res) =>
    execFile('yt-dlp', args, { maxBuffer: 128 * 1024 * 1024, timeout: 240_000 }, (err, out) => {
      if (err) return res(null);
      try { res(JSON.parse(out)); } catch { res(null); }
    })
  );
async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const it = items[i++]; await fn(it); } }));
}

const state = fs.existsSync('channels.json') ? JSON.parse(fs.readFileSync('channels.json', 'utf-8')) : { found: {}, shorts: {} };
const save = () => fs.writeFileSync('channels.json', JSON.stringify(state, null, 1));

await pool(QUERIES.filter((q) => !state.found[q]), 3, async (q) => {
  const j = await run([`https://www.youtube.com/results?search_query=${encodeURIComponent(q)}&sp=EgIQAg%3D%3D`, '--flat-playlist', '-J', '--playlist-end', '15']);
  state.found[q] = (j?.entries ?? []).map((e) => ({ id: e.id, name: e.title, subs: e.channel_follower_count ?? null }));
  save();
  console.log(`search ${q}: ${state.found[q].length}`);
});

const chans = new Map();
for (const [q, list] of Object.entries(state.found)) for (const c of list) if (c.subs && c.subs >= 1000 && !chans.has(c.id)) chans.set(c.id, { ...c, query: q });
const todo = [...chans.values()].filter((c) => !state.shorts[c.id]);
console.log(`channels: ${chans.size}, to fetch: ${todo.length}`);
await pool(todo, 3, async (c) => {
  const j = await run([`https://www.youtube.com/channel/${c.id}/shorts`, '--flat-playlist', '-J', '--playlist-end', '60']);
  state.shorts[c.id] = { name: c.name, subs: c.subs, query: c.query, shorts: (j?.entries ?? []).map((e) => ({ id: e.id, title: e.title, views: e.view_count ?? null })) };
  save();
  console.log(`${c.name} (${c.subs}): ${state.shorts[c.id].shorts.length}`);
});
console.log('done');
