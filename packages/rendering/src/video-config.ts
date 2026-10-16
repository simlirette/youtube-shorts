import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { InternalError, repoRoot } from '@shorts/core';
import { BaseConfigSchema, PointerConfigSchema, VideoConfigSchema, type BaseConfig, type MechanismVideoSpec, type PointerConfig, type VideoConfig } from '@shorts/schemas';
import { hookLine, type CalloutEvent, type PointerLabel, type ProgressSegment } from './overlays.js';
import type { MechanismPlan, NarrationWord, PlanOptions } from './mechanism-video.js';

/**
 * BASE + per-video layers.
 *
 *   base/<version>/base.json        everything shared by all videos (render, voice, caption engine, hook, progress,
 *                                   callout style, outro) + frozen.json (SHA-256 of the visual layer)
 *   videos/<slug>/video.json        what changes per video: subject, script, hook text, callouts, hashtags
 *   videos/<slug>/kit.py            only for a NEW 3D subject
 */

export const baseDir = (version: string): string => path.join(repoRoot(), 'base', version);

export function loadBase(version = 'v1'): BaseConfig {
  const file = path.join(baseDir(version), 'base.json');
  if (!fs.existsSync(file)) throw new InternalError(`base ${version} not found (${file})`);
  const base = BaseConfigSchema.parse(JSON.parse(fs.readFileSync(file, 'utf-8')));
  if (base.version !== version) throw new InternalError(`${file} declares version ${base.version}, expected ${version}`);
  return base;
}

export interface LoadedVideo {
  video: VideoConfig;
  dir: string;
  /** Absolute path of this video's own kit.py, when it brings a new subject. */
  kitFile?: string;
}

export function loadVideo(file: string): LoadedVideo {
  const abs = path.resolve(file);
  const video = VideoConfigSchema.parse(JSON.parse(fs.readFileSync(abs, 'utf-8')));
  const dir = path.dirname(abs);
  const kitFile = video.subject.kitFile ? path.resolve(dir, video.subject.kitFile) : undefined;
  if (kitFile && !fs.existsSync(kitFile)) throw new InternalError(`${video.slug}: kit file ${kitFile} does not exist`);
  return { video, dir, kitFile };
}

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Deep merge: objects merge key by key, everything else (numbers, strings, arrays) is replaced. */
export function mergeDeep<T>(base: T, override: unknown): T {
  if (!isObj(base) || !isObj(override)) return (override === undefined ? base : override) as T;
  const out: Json = { ...base };
  for (const [k, v] of Object.entries(override)) out[k] = k in base ? mergeDeep((base as Json)[k], v) : v;
  return out as T;
}

/** Centre height of the caption block for each zone, % of the frame height. The lower third leaves the subject clear and stays above the platforms' bottom UI. */
export const CAPTION_ZONES = { lower_third: 76, center: 50, upper_third: 24 } as const;

/**
 * Maps the refinement keys (caption.size_pct / zone / max_words, hook.size_pct / duration_s, tracker.*, callout.size_pct)
 * onto the legacy settings the overlay builders read. A key that is absent leaves the legacy value as the fallback,
 * so deleting a section restores the previous look.
 */
export function applyRefinementKeys(cfg: BaseConfig, keys: Pick<BaseConfig, 'caption' | 'tracker' | 'callout'>): BaseConfig {
  const out: BaseConfig = { ...cfg };
  const c = keys.caption;
  if (c) {
    out.captions = {
      ...out.captions,
      font: { ...out.captions.font, sizePct: c.size_pct ?? out.captions.font.sizePct },
      position: { ...out.captions.position, yPct: c.zone ? CAPTION_ZONES[c.zone] : out.captions.position.yPct },
      maxWordsPerCue: c.max_words ?? out.captions.maxWordsPerCue,
    };
  }
  if (out.hook.size_pct !== undefined || out.hook.duration_s !== undefined) {
    out.hook = { ...out.hook, font: { ...out.hook.font, sizePct: out.hook.size_pct ?? out.hook.font.sizePct }, seconds: out.hook.duration_s ?? out.hook.seconds };
  }
  const t = keys.tracker;
  if (t) {
    out.progress = {
      ...out.progress,
      lineHeightPx: t.height_px ?? out.progress.lineHeightPx,
      dimOpacity: t.dim_opacity ?? out.progress.dimOpacity,
      activeFont: { ...out.progress.activeFont, sizePct: t.font_size_pct ?? out.progress.activeFont.sizePct },
      inactiveFont: { ...out.progress.inactiveFont, sizePct: t.font_size_pct !== undefined ? +(t.font_size_pct * 0.6).toFixed(3) : out.progress.inactiveFont.sizePct },
    };
  }
  const k = keys.callout;
  if (k?.size_pct !== undefined) {
    out.callouts = { ...out.callouts, valueFont: { ...out.callouts.valueFont, sizePct: k.size_pct }, labelFont: { ...out.callouts.labelFont, sizePct: +(k.size_pct * (2.2 / 6.5)).toFixed(3) } };
  }
  if (k?.y_pct !== undefined) out.callouts = { ...out.callouts, position: { ...out.callouts.position, yPct: k.y_pct } };
  return out;
}

/** The pointer settings when part labels are drawn in the overlay layer; null keeps the original pills inside the Blender render. */
export function overlayPointers(cfg: BaseConfig): PointerConfig | null {
  return cfg.pointer && cfg.pointer.mode === 'overlay' ? cfg.pointer : null;
}

/** The base with this video's allowed overrides applied (captions, hook, progress, callouts, outro, and the refinement keys). */
export function effectiveConfig(base: BaseConfig, video: VideoConfig): BaseConfig {
  const merged = { ...base };
  const o = video.overrides;
  if (o.captions) merged.captions = BaseConfigSchema.shape.captions.parse(mergeDeep(base.captions, o.captions));
  if (o.hook) merged.hook = BaseConfigSchema.shape.hook.parse(mergeDeep(base.hook, o.hook));
  if (o.progress) merged.progress = BaseConfigSchema.shape.progress.parse(mergeDeep(base.progress, o.progress));
  if (o.callouts) merged.callouts = BaseConfigSchema.shape.callouts.parse(mergeDeep(base.callouts, o.callouts));
  if (o.outro) merged.outro = BaseConfigSchema.shape.outro.parse(mergeDeep(base.outro, o.outro));
  const keys = {
    caption: base.caption || o.caption ? { ...base.caption, ...o.caption } : undefined,
    tracker: base.tracker || o.tracker ? { ...base.tracker, ...o.tracker } : undefined,
    callout: base.callout || o.callout ? { ...base.callout, ...o.callout } : undefined,
  };
  const result = applyRefinementKeys(merged, keys);
  if (base.pointer) result.pointer = PointerConfigSchema.parse(mergeDeep(base.pointer, o.pointer));
  return result;
}

export function hookTextFor(base: BaseConfig, video: VideoConfig): string {
  return hookLine(base.hook.formulas, video.hook);
}

/** The planner's input for this video; the voice always comes from the base. */
export function toMechanismSpec(video: VideoConfig, base: BaseConfig): MechanismVideoSpec {
  return {
    slug: video.slug,
    title: video.title,
    kit: video.subject.kit,
    steps: video.steps,
    speed: base.voice.speed,
    voice: { id: base.voice.id, model: base.voice.model, stability: base.voice.stability, style: base.voice.style },
    beats: video.scenes,
  };
}

/** Planner options for this video. Built-in kits get none of the per-video extras, so their plan is unchanged. */
export function planOptionsFor(video: VideoConfig, cfg: BaseConfig): PlanOptions {
  const o: PlanOptions = {};
  if (cfg.outro.enabled && cfg.outro.mode === 'tail') o.tailSeconds = cfg.outro.seconds;
  if (video.blender?.floorZ !== undefined) o.floorZ = video.blender.floorZ;
  if (video.blender?.events) o.events = video.blender.events;
  if (video.blender?.maxSpeed !== undefined) o.maxSpeed = video.blender.maxSpeed;
  return o;
}

/**
 * The progress tracker's state over the whole video: nothing active before the first step (so it is visible
 * from frame 1), the active step during each step scene, then done / hidden / held after the last one.
 */
export function progressSegments(plan: MechanismPlan, steps: string[], cfg: BaseConfig['progress']): ProgressSegment[] {
  if (!cfg.enabled || steps.length === 0) return [];
  const byStart = new Map(plan.stepper.map((s) => [s.start, s.index]));
  const lastStepStart = Math.max(...plan.stepper.map((s) => s.start));
  const segs: ProgressSegment[] = [];
  let current = -1;
  let pastLast = false;
  for (const b of plan.beats) {
    const idx = byStart.get(b.start);
    if (idx !== undefined) current = idx;
    pastLast = b.start > lastStepStart;
    let index = current;
    if (pastLast) {
      if (cfg.afterLast === 'hide') continue;
      if (cfg.afterLast === 'complete') index = steps.length;
    }
    if (index === -1 && !cfg.visibleFromStart) continue;
    const prev = segs[segs.length - 1];
    if (prev && prev.index === index && Math.abs(prev.end - b.start) < 0.01) prev.end = b.end;
    else segs.push({ start: b.start, end: b.end, index });
  }
  return segs;
}

/** Callout cards with their times resolved from scenes or phrases of the narration. */
export function calloutEvents(video: VideoConfig, cfg: BaseConfig, words: NarrationWord[], plan: MechanismPlan, narration: string): CalloutEvent[] {
  const out: CalloutEvent[] = [];
  for (const c of video.callouts) {
    let start: number;
    if ('scene' in c.at) {
      const b = plan.beats[c.at.scene];
      if (!b) throw new InternalError(`${video.slug}: callout "${c.value}" refers to scene ${c.at.scene}, which does not exist`);
      start = b.start + c.at.fraction * (b.end - b.start);
    } else {
      const at = narration.toLowerCase().indexOf(c.at.phrase.toLowerCase());
      if (at < 0) throw new InternalError(`${video.slug}: callout "${c.value}": the phrase "${c.at.phrase}" is not in the narration`);
      const w = words.find((x) => x.charStart >= at);
      if (!w) throw new InternalError(`${video.slug}: callout "${c.value}": no word found for the phrase`);
      start = w.start;
    }
    const end = Math.min(plan.seconds - 0.05, start + (c.seconds ?? cfg.callouts.seconds));
    if (end - start < 0.4) throw new InternalError(`${video.slug}: callout "${c.value}" starts too close to the end of the video`);
    out.push({ start, end, value: c.value, label: c.label });
  }
  out.sort((a, b) => a.start - b.start);
  for (let i = 1; i < out.length; i++) if (out[i].start < out[i - 1].end) throw new InternalError(`${video.slug}: callouts "${out[i - 1].value}" and "${out[i].value}" overlap`);
  return out;
}

/**
 * With overlay pointers the part labels leave the Blender input: the plan's Blender spec gets an empty `labels` list
 * (nothing else in it changes) and the labels, with their timing and pointer style, are returned for the overlay layer.
 */
export function splitPointerLabels(plan: MechanismPlan, video: VideoConfig): { plan: MechanismPlan; labels: PointerLabel[] } {
  const styles = video.scenes.flatMap((s) => s.labels.map((l) => l.pointer));
  const labels = plan.blender.labels.map((l, i): PointerLabel => ({ text: l.text, part: l.part, t0: l.t0, t1: l.t1, style: styles[i] }));
  return { plan: { ...plan, blender: { ...plan.blender, labels: [] } }, labels };
}

/** Messages (not errors) when the finished length is outside the target range. */
export function lengthWarnings(seconds: number, cfg: BaseConfig): string[] {
  const { min, max } = cfg.render.lengthSeconds;
  if (seconds < min) return [`video is ${seconds.toFixed(1)} s, shorter than the ${min}-${max} s target`];
  if (seconds > max) return [`video is ${seconds.toFixed(1)} s, longer than the ${min}-${max} s target`];
  return [];
}

// ---------------------------------------------------------------------------------------------------------
// Frozen visual layer
// ---------------------------------------------------------------------------------------------------------

export const sha256File = (file: string): string => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

export interface FrozenManifest {
  frozenAt: string;
  files: Record<string, string>;
}

/** Files of the frozen visual layer whose content differs from base/<version>/frozen.json (empty = intact). */
export function verifyFrozen(base: BaseConfig, version = base.version): string[] {
  const manifestFile = path.join(baseDir(version), 'frozen.json');
  if (!fs.existsSync(manifestFile)) return [`${manifestFile} is missing`];
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf-8')) as FrozenManifest;
  const problems: string[] = [];
  for (const rel of base.frozen.files) {
    const abs = path.join(repoRoot(), rel);
    const want = manifest.files[rel];
    if (!want) problems.push(`${rel}: not in frozen.json`);
    else if (!fs.existsSync(abs)) problems.push(`${rel}: missing`);
    else if (sha256File(abs) !== want) problems.push(`${rel}: changed since the base was frozen`);
  }
  return problems;
}
