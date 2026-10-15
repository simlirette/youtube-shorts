import type { ShortFormat } from '@shorts/schemas';

/** One published Short joined with what we know about how it was made. */
export interface PerformanceRow {
  videoId: string;
  title: string;
  format: ShortFormat;
  cluster: string;
  pillar: string;
  words: number;
  durationSeconds: number;
  hookWords: number;
  gapScore: number | null;
  /** Local hour of release (publish slot analysis). */
  publishHour: number | null;
  ageHours: number;
  views: number;
  engagedViews?: number;
  averageViewPercentage?: number;
  likes?: number;
  subscribersGained?: number;
  /** Production variant (absent on Shorts made before variants were recorded). */
  hookType?: string;
  durationBand?: string;
  titleCard?: boolean;
  music?: boolean;
  musicTrackId?: string | null;
  captionStyle?: string;
  voiceSpeed?: number;
  experimentId?: string | null;
  experimentFactor?: string | null;
  arm?: string | null;
  editorTotal?: number | null;
}

export interface GroupStats {
  key: string;
  n: number;
  medianViewsPerDay: number;
  medianViews: number;
  medianAvgViewPct: number | null;
  medianEngagedRate: number | null;
  subscribersGained: number;
}

export interface PerformanceReport {
  videos: number;
  /** Shorts younger than this are excluded from comparisons (views still accumulating). */
  minAgeHours: number;
  overall: GroupStats | null;
  byFormat: GroupStats[];
  byCluster: GroupStats[];
  byLength: GroupStats[];
  byPublishHour: GroupStats[];
  /** Variant factors (only rows that recorded the factor are grouped). */
  byVariant: Record<string, GroupStats[]>;
  top: PerformanceRow[];
  bottom: PerformanceRow[];
  recommendations: string[];
  formatWeights: Partial<Record<ShortFormat, number>>;
}

const median = (xs: number[]): number => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const perDay = (r: PerformanceRow) => r.views / Math.max(1, r.ageHours / 24);
const round = (x: number, d = 1) => Math.round(x * 10 ** d) / 10 ** d;

function stats(key: string, rows: PerformanceRow[]): GroupStats {
  const pct = rows.map((r) => r.averageViewPercentage).filter((x): x is number => typeof x === 'number');
  const eng = rows.filter((r) => typeof r.engagedViews === 'number' && r.views > 0).map((r) => r.engagedViews! / r.views);
  return {
    key,
    n: rows.length,
    medianViewsPerDay: round(median(rows.map(perDay))),
    medianViews: median(rows.map((r) => r.views)),
    medianAvgViewPct: pct.length ? round(median(pct)) : null,
    medianEngagedRate: eng.length ? round(median(eng), 3) : null,
    subscribersGained: rows.reduce((s, r) => s + (r.subscribersGained ?? 0), 0),
  };
}

function group(rows: PerformanceRow[], keyOf: (r: PerformanceRow) => string): GroupStats[] {
  const m = new Map<string, PerformanceRow[]>();
  for (const r of rows) m.set(keyOf(r), [...(m.get(keyOf(r)) ?? []), r]);
  return [...m.entries()].map(([k, v]) => stats(k, v)).sort((a, b) => b.medianViewsPerDay - a.medianViewsPerDay);
}

const lengthBucket = (s: number) => (s < 25 ? '<25s' : s < 35 ? '25-35s' : s < 45 ? '35-45s' : '45s+');

/**
 * Compares what was made against how it performed. Conclusions are only drawn for groups with at
 * least `minGroup` Shorts; below that the report says so instead of over-reading noise.
 */
export function analyzePerformance(all: PerformanceRow[], opts: { minAgeHours?: number; minGroup?: number } = {}): PerformanceReport {
  const minAgeHours = opts.minAgeHours ?? 48;
  const minGroup = opts.minGroup ?? 3;
  const rows = all.filter((r) => r.ageHours >= minAgeHours);
  const byFormat = group(rows, (r) => r.format);
  const byCluster = group(rows, (r) => r.cluster);
  const byLength = group(rows, (r) => lengthBucket(r.durationSeconds));
  const byPublishHour = group(rows.filter((r) => r.publishHour !== null), (r) => `${String(r.publishHour).padStart(2, '0')}:00`);
  const overall = rows.length ? stats('all', rows) : null;
  const factor = (name: keyof PerformanceRow) => group(rows.filter((r) => r[name] !== undefined && r[name] !== null), (r) => String(r[name]));
  const byVariant: Record<string, GroupStats[]> = {
    hookType: factor('hookType'),
    durationBand: factor('durationBand'),
    titleCard: factor('titleCard'),
    music: factor('music'),
    captionStyle: factor('captionStyle'),
    voiceSpeed: factor('voiceSpeed'),
  };
  const sorted = [...rows].sort((a, b) => perDay(b) - perDay(a));

  const recommendations: string[] = [];
  const formatWeights: Partial<Record<ShortFormat, number>> = {};
  if (rows.length < 6) {
    recommendations.push(`Only ${rows.length} Short(s) older than ${minAgeHours} h — too few to compare. Keep rotating formats and clusters evenly until at least 6–10 have aged.`);
  } else {
    const base = Math.log10((overall?.medianViewsPerDay ?? 0) + 1);
    for (const g of byFormat.filter((x) => x.n >= minGroup)) {
      // Additive nudge on the rotation score: +-3 positions at most, from log-ratio to the median.
      const w = Math.max(-3, Math.min(3, round(3 * (Math.log10(g.medianViewsPerDay + 1) - base), 2)));
      formatWeights[g.key as ShortFormat] = w;
    }
    const strong = (gs: GroupStats[]) => gs.filter((g) => g.n >= minGroup);
    const bf = strong(byFormat);
    if (bf.length >= 2) recommendations.push(`Format: "${bf[0].key}" leads (${bf[0].medianViewsPerDay} views/day median, n=${bf[0].n}) vs "${bf[bf.length - 1].key}" (${bf[bf.length - 1].medianViewsPerDay}, n=${bf[bf.length - 1].n}); rotation now favours it but keeps variety.`);
    const bc = strong(byCluster);
    if (bc.length >= 2) recommendations.push(`Topic cluster: "${bc[0].key}" performs best (${bc[0].medianViewsPerDay} views/day); weight GAP_SEEDS toward it and drop or rethink "${bc[bc.length - 1].key}" (${bc[bc.length - 1].medianViewsPerDay}).`);
    const bl = strong(byLength);
    if (bl.length >= 2) recommendations.push(`Length: ${bl[0].key} Shorts lead (${bl[0].medianViewsPerDay} views/day); prefer formats that land there.`);
    const bh = strong(byPublishHour);
    if (bh.length >= 2) recommendations.push(`Release time: ${bh[0].key} (${PUBLISH_TZ_NOTE}) leads; consider moving PUBLISH_SLOTS toward it.`);
    if (overall?.medianAvgViewPct !== null && overall?.medianAvgViewPct !== undefined) {
      if (overall.medianAvgViewPct < 40) recommendations.push(`Retention is weak (median ${overall.medianAvgViewPct}% viewed; 30–60 s Shorts should clear ~40%). Answer the question sooner and cut the first sentence after the hook.`);
      else recommendations.push(`Retention is healthy (median ${overall.medianAvgViewPct}% viewed).`);
    }
    if (overall?.medianEngagedRate !== null && overall?.medianEngagedRate !== undefined && overall.medianEngagedRate < 0.5) {
      recommendations.push(`Only ${Math.round(overall.medianEngagedRate * 100)}% of views are engaged: the first 2 seconds lose most viewers. Make frame 1 show the subject of the question.`);
    }
  }
  return { videos: rows.length, minAgeHours, overall, byFormat, byCluster, byLength, byPublishHour, byVariant, top: sorted.slice(0, 5), bottom: sorted.slice(-5).reverse(), recommendations, formatWeights };
}

const PUBLISH_TZ_NOTE = 'PUBLISH_TIMEZONE local time';

/** Markdown rendering of a report, for humans. */
export function renderPerformanceReport(r: PerformanceReport): string {
  const table = (title: string, gs: GroupStats[]) =>
    gs.length === 0
      ? ''
      : [
          `### ${title}`,
          '| group | n | median views/day | median views | median % viewed | engaged rate | subs gained |',
          '|---|---|---|---|---|---|---|',
          ...gs.map((g) => `| ${g.key} | ${g.n} | ${g.medianViewsPerDay} | ${g.medianViews} | ${g.medianAvgViewPct ?? '—'} | ${g.medianEngagedRate ?? '—'} | ${g.subscribersGained} |`),
          '',
        ].join('\n');
  const list = (rows: PerformanceRow[]) => rows.map((x) => `- ${x.title} — ${x.views} views in ${Math.round(x.ageHours)} h (${x.format}, ${x.cluster}, ${Math.round(x.durationSeconds)} s)`).join('\n');
  return [
    `# Channel performance`,
    '',
    `Shorts compared: ${r.videos} (older than ${r.minAgeHours} h).`,
    '',
    '## Recommendations',
    ...r.recommendations.map((x) => `- ${x}`),
    '',
    table('By format', r.byFormat),
    table('By topic cluster', r.byCluster),
    table('By length', r.byLength),
    table('By release hour', r.byPublishHour),
    ...Object.entries(r.byVariant).map(([k, gs]) => table(`By ${k}`, gs)),
    r.top.length ? `## Best\n${list(r.top)}\n` : '',
    r.bottom.length ? `## Weakest\n${list(r.bottom)}\n` : '',
  ].join('\n');
}

// =============================================================================
// Controlled experiments (one factor at a time)
// =============================================================================

export interface ArmStats {
  arm: string;
  n: number;
  /** Primary metric: engaged views per day when available for every Short in the arm, else views per day. */
  metric: 'engagedViewsPerDay' | 'viewsPerDay';
  median: number;
  q1: number;
  q3: number;
  medianAvgViewPct: number | null;
}

export interface ExperimentReport {
  experimentId: string;
  factor: string | null;
  arms: ArmStats[];
  minPerArm: number;
  status: 'insufficient data' | 'no clear difference' | 'provisional leader';
  /** Plain-language reading that states sample sizes and uncertainty; never claims significance. */
  summary: string;
}

const quantile = (xs: number[], q: number) => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
};

/**
 * Screening report for one experiment. With fewer than `minPerArm` aged Shorts in any arm it only
 * reports "insufficient data". A ≥20 % median lift with no loss in average % viewed and
 * non-overlapping interquartile ranges is a *provisional* leader — a screening signal, not proof.
 */
export function experimentReport(all: PerformanceRow[], experimentId: string, opts: { minAgeHours?: number; minPerArm?: number; lift?: number } = {}): ExperimentReport {
  const minAge = opts.minAgeHours ?? 72;
  const minPerArm = opts.minPerArm ?? 8;
  const liftNeeded = opts.lift ?? 0.2;
  const rows = all.filter((r) => r.experimentId === experimentId && r.arm && r.ageHours >= minAge);
  const factorName = all.find((r) => r.experimentId === experimentId)?.experimentFactor ?? null;
  const byArm = new Map<string, PerformanceRow[]>();
  for (const r of rows) byArm.set(r.arm!, [...(byArm.get(r.arm!) ?? []), r]);
  const useEngaged = rows.length > 0 && rows.every((r) => typeof r.engagedViews === 'number');
  const metricOf = (r: PerformanceRow) => (useEngaged ? r.engagedViews! : r.views) / Math.max(1, r.ageHours / 24);
  const arms: ArmStats[] = [...byArm.entries()]
    .map(([arm, rs]) => {
      const m = rs.map(metricOf);
      const pct = rs.map((r) => r.averageViewPercentage).filter((x): x is number => typeof x === 'number');
      return {
        arm,
        n: rs.length,
        metric: useEngaged ? ('engagedViewsPerDay' as const) : ('viewsPerDay' as const),
        median: round(median(m)),
        q1: round(quantile(m, 0.25)),
        q3: round(quantile(m, 0.75)),
        medianAvgViewPct: pct.length === rs.length && pct.length > 0 ? round(median(pct)) : null,
      };
    })
    .sort((a, b) => b.median - a.median);
  const sizes = arms.map((a) => `${a.arm} n=${a.n}`).join(', ') || 'no aged Shorts yet';
  if (arms.length < 2 || arms.some((a) => a.n < minPerArm)) {
    return { experimentId, factor: factorName, arms, minPerArm, status: 'insufficient data', summary: `Insufficient data (${sizes}; need ≥ ${minPerArm} Shorts older than ${minAge} h per arm). Keep rotating.` };
  }
  const [a, b] = arms;
  const lift = b.median > 0 ? a.median / b.median - 1 : a.median > 0 ? Infinity : 0;
  const retentionOk = a.medianAvgViewPct === null || b.medianAvgViewPct === null || a.medianAvgViewPct >= b.medianAvgViewPct;
  const separated = a.q1 > b.q3;
  if (lift >= liftNeeded && retentionOk && separated) {
    return {
      experimentId,
      factor: factorName,
      arms,
      minPerArm,
      status: 'provisional leader',
      summary: `Provisional: "${a.arm}" median ${a.median} vs "${b.arm}" ${b.median} ${a.metric} (+${Math.round(lift * 100)}%, ${sizes}); % viewed not worse; interquartile ranges do not overlap. Small samples — confirm with a second batch before adopting.`,
    };
  }
  return {
    experimentId,
    factor: factorName,
    arms,
    minPerArm,
    status: 'no clear difference',
    summary: `No clear difference yet (${sizes}; lift ${Number.isFinite(lift) ? Math.round(lift * 100) : '∞'}%${retentionOk ? '' : ', leader loses % viewed'}${separated ? '' : ', ranges overlap'}).`,
  };
}
