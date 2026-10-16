// Sourcing: what performs in the 3D-explainer niche on YouTube (public data via yt-dlp, no API key).
//   node research/2026-10-sourcing/collect.mjs
// Writes videos.json (every video found) and channels.json (follower counts), then analyse.mjs ranks them.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const OUT = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));

const QUERIES = {
  mechanism: [
    'how a differential works 3d animation', 'how a gearbox works 3d animation', 'how a pump works animation',
    'how a lock works animation', 'how a jet engine works 3d', 'how a turbocharger works animation',
    'how disc brakes work 3d animation', 'how a clutch works animation', 'how a hydraulic press works',
    'how a car engine works 3d animation', 'how a combustion engine works shorts', 'how a rotary engine works animation',
    'how a bicycle gear derailleur works', 'how a zipper works animation', 'how a mechanical watch works 3d',
  ],
  howthingswork: [
    'how a microwave works animation', 'how a refrigerator works animation', 'how a toilet flush works animation',
    'how does a touchscreen work animation', 'how does a battery work 3d animation', 'how an elevator works animation',
    'how a washing machine works animation', 'how an air conditioner works 3d',
  ],
  design: [
    'why are manhole covers round', 'why do airplane windows have a small hole', 'why do bridges have gaps expansion joints',
    'why are skyscrapers shaped like that engineering', 'why do wheels have spokes engineering why',
    'why is the keyboard layout qwerty engineering', 'why do cars have a spare tire design',
  ],
  history: [
    'history of the transistor explained shorts', 'who invented the internal combustion engine short',
    'history of the steam engine animation short', 'evolution of the lock history engineering short',
    'history of the wheel invention short', 'how the printing press changed engineering short',
  ],
  ai_computing: [
    'how a neural network works animation short', 'how a database index works animation', 'what is a vector database explained short',
    'how does a gpu work animation', 'how does chatgpt work animation short', 'how does a cpu work animation',
    'how does ssd storage work animation', 'how does wifi work animation short', 'how a hash table works animation',
  ],
  investigative: [
    'how much water does ai use data center short', 'does ai cause water scarcity', 'how much electricity does ai use short',
    'why data centers need so much water explained', 'hidden cost of one chatgpt query explained',
  ],
};

const flat = async (url, extra = []) => {
  try {
    const { stdout } = await run('yt-dlp', ['--no-update', '--flat-playlist', '-J', ...extra, url], { maxBuffer: 64 * 1024 * 1024, timeout: 120000 });
    return JSON.parse(stdout);
  } catch {
    return null;
  }
};

const pool = async (items, n, fn) => {
  const out = [];
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < items.length) {
      const k = i++;
      out[k] = await fn(items[k], k);
    }
  }));
  return out;
};

const jobs = Object.entries(QUERIES).flatMap(([cat, qs]) => qs.map((q) => ({ cat, q })));
console.log(`${jobs.length} searches`);
const found = await pool(jobs, 6, async ({ cat, q }) => {
  const d = await flat(`ytsearch30:${q}`);
  const entries = (d?.entries ?? []).filter(Boolean);
  console.log(`  ${cat} | ${q} -> ${entries.length}`);
  return entries.map((e) => ({
    id: e.id, title: e.title, views: e.view_count ?? null, duration: e.duration ?? null,
    channel: e.channel ?? e.uploader ?? null, channelId: e.channel_id ?? null, channelUrl: e.channel_url ?? e.uploader_url ?? null,
    category: cat, query: q,
  }));
});

const byId = new Map();
for (const v of found.flat()) {
  const prev = byId.get(v.id);
  if (!prev) byId.set(v.id, { ...v, categories: [v.category], queries: [v.query] });
  else {
    if (!prev.categories.includes(v.category)) prev.categories.push(v.category);
    if (!prev.queries.includes(v.query)) prev.queries.push(v.query);
  }
}
const videos = [...byId.values()];
fs.writeFileSync(path.join(OUT, 'videos.json'), JSON.stringify(videos, null, 1));
console.log(`${videos.length} unique videos`);

// Channel sizes for every channel that has at least one video over 100k views or a short-form duration.
const chans = new Map();
for (const v of videos) if (v.channelId && (v.views ?? 0) > 50_000) chans.set(v.channelId, v.channelUrl ?? `https://www.youtube.com/channel/${v.channelId}`);
console.log(`${chans.size} channels to size`);
const sized = await pool([...chans.entries()], 6, async ([id, url]) => {
  const d = await flat(`${url.replace(/\/$/, '')}/videos`, ['--playlist-items', '1']);
  const followers = d?.channel_follower_count ?? null;
  console.log(`  ${d?.channel ?? id}: ${followers}`);
  return { id, name: d?.channel ?? null, followers, url };
});
fs.writeFileSync(path.join(OUT, 'channels.json'), JSON.stringify(sized, null, 1));
console.log('done');
