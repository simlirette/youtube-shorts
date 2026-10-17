import type { BaseConfig, VideoConfig } from '@shorts/schemas';
import { emphasisIndex } from './captions.js';
import type { MechanismPlan, NarrationWord } from './mechanism-video.js';
import {
  buildCalloutOverlay,
  buildCaptionOverlay,
  buildHookOverlay,
  buildOutroOverlay,
  buildPointerOverlay,
  buildProgressOverlay,
  captionCues,
  textFx,
  type AnchorTracks,
  type CalloutEvent,
  type PointerLabel,
  type ProgressSegment,
} from './overlays.js';
import { overlayPointers } from './video-config.js';

const wordKey = (w: string): string => w.toLowerCase().replace(/[^a-z0-9']/g, '');

/**
 * The one word per scene that may be yellow (highlight.policy "single"), as indices into the narration words.
 * A scene that carries a fact card gets none: the card's figure is that scene's yellow item. Otherwise the word is the
 * video's own pick (`highlights`), or the longest meaningful word of the scene. Words under the hook and the outro are
 * skipped because no caption is drawn there.
 */
export function pickKeywords(plan: MechanismPlan, words: NarrationWord[], video: VideoConfig, callouts: CalloutEvent[], cfg: BaseConfig): Set<number> {
  const picked = new Set<number>();
  const hookEnd = cfg.hook.enabled ? cfg.hook.seconds : 0;
  const outroStart = cfg.outro.enabled ? plan.seconds - cfg.outro.seconds : Infinity;
  for (const b of plan.beats) {
    if (callouts.some((c) => c.start >= b.start - 1e-6 && c.start < b.end)) continue;
    const idx = words.map((w, i) => i).filter((i) => words[i].start >= b.start - 1e-6 && words[i].start < b.end && words[i].start >= hookEnd && words[i].end <= outroStart);
    if (idx.length === 0) continue;
    const own = video.highlights.find((h) => h.scene === b.index);
    let at = own ? idx.find((i) => wordKey(words[i].word) === wordKey(own.word)) : undefined;
    if (at === undefined) {
      const k = emphasisIndex(idx.map((i) => words[i].word.toUpperCase()));
      if (k >= 0) at = idx[k];
    }
    if (at !== undefined) picked.add(at);
  }
  return picked;
}

export interface OverlayLayerInputs {
  cfg: BaseConfig;
  video: VideoConfig;
  words: NarrationWord[];
  plan: MechanismPlan;
  hook: string;
  callouts: CalloutEvent[];
  segments: ProgressSegment[];
  pointerLabels: PointerLabel[];
  tracks: AnchorTracks;
  fps: number;
}

/** Every overlay layer of a video, in the order they are burned in, for the style held in `cfg` (classic or premium). */
export function overlayLayers(i: OverlayLayerInputs): Array<{ name: string; ass: string }> {
  const { cfg, video, words, plan } = i;
  const fx = textFx(cfg.text);
  const suppress: Array<[number, number]> = [];
  if (cfg.captions.hideDuringHook && cfg.hook.enabled) suppress.push([0, cfg.hook.seconds]);
  const outroStart = Math.max(0, plan.seconds - cfg.outro.seconds);
  if (cfg.outro.enabled) suppress.push([outroStart, plan.seconds]);
  const ptr = overlayPointers(cfg);
  const layers: Array<{ name: string; ass: string }> = [];
  if (cfg.progress.enabled && video.steps) layers.push({ name: 'progress', ass: buildProgressOverlay(video.steps, i.segments, cfg.progress, undefined, undefined, cfg.progress.useTextEffects === false ? null : fx) });
  if (ptr && i.pointerLabels.length) layers.push({ name: 'pointers', ass: buildPointerOverlay(i.pointerLabels, i.tracks, ptr, i.fps) });
  if (i.callouts.length) layers.push({ name: 'callouts', ass: buildCalloutOverlay(i.callouts, cfg.callouts, undefined, undefined, { style: cfg.callout?.style, fx, highlight: cfg.highlight }) });
  if (cfg.hook.enabled) layers.push({ name: 'hook', ass: buildHookOverlay(i.hook, cfg.hook, undefined, undefined, fx) });
  if (cfg.outro.enabled) layers.push({ name: 'outro', ass: buildOutroOverlay(outroStart, plan.seconds, cfg.outro, undefined, undefined, fx) });
  if (cfg.captions.enabled) {
    const keywords = cfg.highlight?.policy === 'single' ? pickKeywords(plan, words, video, i.callouts, cfg) : undefined;
    layers.push({ name: 'captions', ass: buildCaptionOverlay(captionCues(words, cfg.captions), words, cfg.captions, { display: video.captionText, suppress, fx, highlight: cfg.highlight, keywords }) });
  }
  return layers;
}
