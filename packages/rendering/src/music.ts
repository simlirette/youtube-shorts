import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { measureLoudness, summarizeMedia } from '@shorts/core';

/**
 * Local background-music library. Tracks are added by a human (e.g. downloaded manually from the
 * YouTube Audio Library) together with their licence terms and the evidence of those terms. Nothing
 * is downloaded or approved automatically: a track is only used when `approved` is true.
 */
export const MusicTrackSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9._-]{1,60}$/),
  /** File path relative to the library manifest. */
  file: z.string().min(1),
  title: z.string().min(1),
  artist: z.string().default(''),
  /** e.g. "youtube_audio_library". */
  source: z.string().min(3),
  /** Licence terms as stated by the source. */
  licence: z.string().min(3),
  /** Where/how the licence was verified (URL, screenshot path, note). Required. */
  licenceEvidence: z.string().min(3),
  attributionRequired: z.boolean(),
  attributionText: z.string().default(''),
  approved: z.boolean(),
  approvedBy: z.string().optional(),
  approvedAt: z.string().optional(),
});
export type MusicTrack = z.infer<typeof MusicTrackSchema>;

export const MusicLibrarySchema = z.object({ tracks: z.array(z.unknown()) });

export interface LoadedTrack extends MusicTrack {
  filePath: string;
  durationSeconds: number;
  integratedLufs: number;
}

export interface MusicLibraryResult {
  tracks: LoadedTrack[];
  /** Why tracks (or the whole library) were not usable. Never silently dropped. */
  problems: string[];
}

/** Loads and validates the library: only approved, evidenced, decodable tracks are returned. */
export async function loadMusicLibrary(manifestPath: string): Promise<MusicLibraryResult> {
  if (!fs.existsSync(manifestPath)) return { tracks: [], problems: [`no music library manifest at ${manifestPath}`] };
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
  } catch (e) {
    return { tracks: [], problems: [`music library manifest is not valid JSON: ${(e as Error).message}`] };
  }
  const lib = MusicLibrarySchema.safeParse(raw);
  if (!lib.success) return { tracks: [], problems: ['music library manifest must be {"tracks": [...]}'] };
  const dir = path.dirname(manifestPath);
  const tracks: LoadedTrack[] = [];
  const problems: string[] = [];
  for (const [i, t] of lib.data.tracks.entries()) {
    const parsed = MusicTrackSchema.safeParse(t);
    if (!parsed.success) {
      problems.push(`track #${i + 1}: invalid metadata (${parsed.error.issues.map((x) => `${x.path.join('.')}: ${x.message}`).join('; ')})`);
      continue;
    }
    const tr = parsed.data;
    if (!tr.approved) {
      problems.push(`track ${tr.id}: not approved`);
      continue;
    }
    if (tr.attributionRequired) {
      problems.push(`track ${tr.id}: requires attribution, which publishing does not add yet`);
      continue;
    }
    const filePath = path.resolve(dir, tr.file);
    if (!filePath.startsWith(path.resolve(dir))) {
      problems.push(`track ${tr.id}: file must live inside the library directory`);
      continue;
    }
    if (!fs.existsSync(filePath)) {
      problems.push(`track ${tr.id}: file missing (${tr.file})`);
      continue;
    }
    try {
      const probe = await summarizeMedia(filePath);
      if (!probe.audio || probe.durationSeconds < 5) throw new Error('no audio stream or shorter than 5 s');
      const loud = await measureLoudness(filePath);
      if (!Number.isFinite(loud.integratedLufs)) throw new Error('loudness could not be measured');
      tracks.push({ ...tr, filePath, durationSeconds: probe.durationSeconds, integratedLufs: loud.integratedLufs });
    } catch (e) {
      problems.push(`track ${tr.id}: unusable audio (${(e as Error).message})`);
    }
  }
  return { tracks, problems };
}

/** Deterministic choice for a job (stable across retries and resumes). */
export function selectTrack(tracks: LoadedTrack[], jobId: string): LoadedTrack | null {
  if (tracks.length === 0) return null;
  const sorted = [...tracks].sort((a, b) => a.id.localeCompare(b.id));
  const h = createHash('sha256').update(jobId).digest().readUInt32BE(0);
  return sorted[h % sorted.length];
}

/** Gain (dB) that puts the track `bedLu` below the narration's integrated loudness. */
export function bedGainDb(narrationLufs: number, trackLufs: number, bedLu: number): number {
  return Math.max(-40, Math.min(6, Math.round((narrationLufs - bedLu - trackLufs) * 10) / 10));
}
