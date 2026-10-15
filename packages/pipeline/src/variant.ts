import { AppConfig, ConfigurationError } from '@shorts/core';
import {
  CaptionStyleSchema,
  DurationBandSchema,
  HookTypeSchema,
  ProductionVariant,
  ProductionVariantSchema,
  ShortFormatSchema,
  type ShortFormat,
} from '@shorts/schemas';

export const EXPERIMENT_FACTORS = ['hookType', 'durationBand', 'titleCard', 'music', 'captionStyle', 'voiceSpeed', 'format'] as const;
export type ExperimentFactor = (typeof EXPERIMENT_FACTORS)[number];

export interface ExperimentSpec {
  id: string;
  factor: ExperimentFactor;
  arms: string[];
}

/** Parses EXPERIMENT ("id|factor|valueA,valueB"); null when no experiment is configured. */
export function parseExperiment(spec: string): ExperimentSpec | null {
  if (!spec.trim()) return null;
  const [id, factor, values] = spec.split('|').map((x) => (x ?? '').trim());
  if (!/^[A-Za-z0-9._-]{1,40}$/.test(id ?? '')) throw new ConfigurationError(`EXPERIMENT id "${id}" must be 1-40 characters [A-Za-z0-9._-]`);
  if (!(EXPERIMENT_FACTORS as readonly string[]).includes(factor)) throw new ConfigurationError(`EXPERIMENT factor "${factor}" must be one of ${EXPERIMENT_FACTORS.join(', ')}`);
  const arms = (values ?? '').split(',').map((v) => v.trim()).filter(Boolean);
  if (arms.length < 2 || new Set(arms).size !== arms.length) throw new ConfigurationError('EXPERIMENT needs at least two distinct values');
  for (const a of arms) applyFactor(baseVariant({} as never, 'x'), factor as ExperimentFactor, a); // validates each value
  return { id, factor: factor as ExperimentFactor, arms };
}

/** The production default: every choice comes from configuration. */
export function baseVariant(cfg: AppConfig, assignment: string): ProductionVariant {
  const formats = String(cfg.SHORT_FORMATS ?? 'MICRO_EXPLAINER').split(',').map((f) => f.trim()).filter(Boolean);
  return {
    experimentId: null,
    factor: null,
    arm: null,
    assignment,
    hookType: cfg.HOOK_TYPE ?? 'statement',
    format: formats.length === 1 ? (formats[0] as ShortFormat) : 'auto',
    durationBand: cfg.DURATION_BAND ?? 'standard',
    captionStyle: cfg.CAPTION_STYLE ?? 'plain',
    titleCard: cfg.TITLE_CARD ?? true,
    music: cfg.MUSIC_ENABLED ?? true,
    voiceId: cfg.ELEVENLABS_VOICE_ID ?? 'default',
    voiceSpeed: cfg.ELEVENLABS_SPEED ?? 1.1,
    cta: cfg.CTA_ENABLED ?? false,
    assignedAt: new Date().toISOString(),
  };
}

/** Sets one factor to a value given as text, validating it. */
export function applyFactor(v: ProductionVariant, factor: ExperimentFactor, value: string): ProductionVariant {
  const bool = (x: string) => {
    if (x !== 'true' && x !== 'false') throw new ConfigurationError(`EXPERIMENT ${factor} values must be true/false (got "${x}")`);
    return x === 'true';
  };
  switch (factor) {
    case 'hookType':
      return { ...v, hookType: HookTypeSchema.parse(value) };
    case 'durationBand':
      return { ...v, durationBand: DurationBandSchema.parse(value) };
    case 'captionStyle':
      return { ...v, captionStyle: CaptionStyleSchema.parse(value) };
    case 'titleCard':
      return { ...v, titleCard: bool(value) };
    case 'music':
      return { ...v, music: bool(value) };
    case 'voiceSpeed': {
      const n = Number(value);
      if (!Number.isFinite(n) || n < 0.7 || n > 1.2) throw new ConfigurationError(`EXPERIMENT voiceSpeed must be 0.7-1.2 (got "${value}")`);
      return { ...v, voiceSpeed: n };
    }
    case 'format':
      return { ...v, format: ShortFormatSchema.parse(value) };
  }
}

/**
 * Deterministic, auditable assignment: the n-th job of an experiment gets arm n mod k (balanced
 * round-robin). Everything else stays at the production default, so exactly one factor varies.
 */
export function assignVariant(cfg: AppConfig, priorJobsInExperiment: number): ProductionVariant {
  const exp = parseExperiment(cfg.EXPERIMENT ?? '');
  if (!exp) return ProductionVariantSchema.parse(baseVariant(cfg, 'production default'));
  const arm = exp.arms[priorJobsInExperiment % exp.arms.length];
  const v = applyFactor(baseVariant(cfg, `round-robin #${priorJobsInExperiment + 1} of ${exp.id} (${exp.arms.length} arms)`), exp.factor, arm);
  return ProductionVariantSchema.parse({ ...v, experimentId: exp.id, factor: exp.factor, arm });
}
