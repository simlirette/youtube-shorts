// Niche demand/supply sweep over YouTube Shorts via yt-dlp (free; no API key).
// For each niche query: Shorts uploaded this year and this month (YouTube search filters),
// keep entries <= 60 s, record view counts. Output: sweep.json
import { execFile } from 'node:child_process';
import fs from 'node:fs';

const NICHES = {
  engineering_failures: 'engineering failure explained',
  disasters_explained: 'disaster explained',
  strange_history: 'strange history facts',
  history_mysteries: 'unsolved history mystery',
  science_facts: 'science facts',
  space_facts: 'space facts',
  deep_ocean: 'deep ocean facts',
  animal_facts: 'animal facts',
  human_body: 'human body facts',
  psychology_facts: 'psychology facts',
  money_history: 'why is it so expensive',
  business_failures: 'company failure story',
  brand_origins: 'brand origin story',
  inventions: 'invention origin story',
  weird_laws: 'weird laws',
  food_origins: 'food history facts',
  military_oddities: 'military history facts',
  aviation_incidents: 'plane crash explained',
  medical_history: 'medical history facts',
  nature_phenomena: 'nature phenomenon explained',
  how_its_made: 'how it is made factory',
  abandoned_places: 'abandoned places history',
  ancient_civilizations: 'ancient civilization facts',
  etymology: 'word origin etymology',
  survival_stories: 'survival story true',
  extreme_weather: 'extreme weather explained',
  dinosaurs: 'dinosaur facts',
  tech_history: 'tech history facts',
  scams_frauds: 'biggest scam in history',
  shipwrecks: 'shipwreck story',
  everyday_design: 'why is it designed this way',
  megaprojects: 'megaproject engineering',
  nuclear_energy: 'nuclear accident explained',
  geography_facts: 'geography facts',
};
// YouTube search filter protobufs: upload date (4=month, 5=year) + type video + duration short (<4 min)
const SP = { year: 'CAMSBggFEAEYAQ%3D%3D', month: 'CAMSBggEEAEYAQ%3D%3D' };
const N = Number(process.env.SWEEP_N ?? 40);

function search(query, sp) {
  const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(query + ' #shorts')}&sp=${sp}`;
  return new Promise((resolve) => {
    execFile('yt-dlp', [url, '--flat-playlist', '-J', '--playlist-end', String(N)], { maxBuffer: 64 * 1024 * 1024, timeout: 180_000 }, (err, stdout) => {
      if (err) return resolve({ error: String(err.message).slice(0, 200), entries: [] });
      try {
        const j = JSON.parse(stdout);
        resolve({ entries: (j.entries ?? []).map((e) => ({ id: e.id, title: e.title, views: e.view_count ?? null, dur: e.duration ?? null, ch: e.channel ?? e.uploader ?? null, chId: e.channel_id ?? null })) });
      } catch (e) {
        resolve({ error: 'parse', entries: [] });
      }
    });
  });
}

const out = fs.existsSync('sweep_top.json') ? JSON.parse(fs.readFileSync('sweep_top.json', 'utf-8')) : {};
const jobs = [];
for (const [key, q] of Object.entries(NICHES)) for (const w of ['year', 'month']) if (!out[key]?.[w]) jobs.push({ key, q, w });
let i = 0;
async function worker() {
  while (i < jobs.length) {
    const j = jobs[i++];
    const r = await search(j.q, SP[j.w]);
    out[j.key] ??= { query: j.q };
    out[j.key][j.w] = r;
    fs.writeFileSync('sweep_top.json', JSON.stringify(out, null, 1));
    console.log(`${j.key}/${j.w}: ${r.entries.length}${r.error ? ' ERR ' + r.error : ''}`);
  }
}
await Promise.all([worker(), worker(), worker()]);
console.log('done');
