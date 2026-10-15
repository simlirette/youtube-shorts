import { z } from 'zod';
import type { Claim, SourceAssessment, SourceCategory, SourceCredibility, SourceReference } from '@shorts/schemas';
import { SourceCategorySchema } from '@shorts/schemas';
import type { LLMProvider } from '@shorts/providers';

/**
 * Source publication policy.
 *
 * Supporting a claim (verification) and being suitable to cite publicly (credibility) are separate
 * questions. Credibility is decided by:
 *   1. curated domain rules (allow-list → HIGH / ACCEPTABLE, deny-list → REJECTED / QUESTIONABLE), then
 *   2. for unknown domains, an LLM *category* judgment mapped to a tier by the fixed table below.
 *      The LLM never assigns a tier directly, and an unknown domain can never become HIGH.
 */

const rank: Record<SourceCredibility, number> = { HIGH: 3, ACCEPTABLE: 2, QUESTIONABLE: 1, REJECTED: 0 };
export const credibilityRank = (t: SourceCredibility) => rank[t];
export const isCitable = (t: SourceCredibility | undefined) => t === 'HIGH' || t === 'ACCEPTABLE';

/** Public-sector and academic suffixes (matched against the hostname). */
const HIGH_SUFFIXES = ['.gov', '.mil', '.edu', '.int', '.gov.uk', '.gov.au', '.gc.ca', '.gouv.fr', '.gov.in', '.govt.nz', '.europa.eu', '.ac.uk', '.ac.jp', '.ac.nz', '.edu.au'];

const HIGH_DOMAINS: Record<string, SourceCategory> = {
  'nature.com': 'scientific_organization', 'science.org': 'scientific_organization', 'pnas.org': 'scientific_organization',
  'cell.com': 'scientific_organization', 'thelancet.com': 'scientific_organization', 'nejm.org': 'scientific_organization',
  'bmj.com': 'scientific_organization', 'royalsociety.org': 'scientific_organization', 'royalsocietypublishing.org': 'scientific_organization',
  'ieee.org': 'scientific_organization', 'acs.org': 'scientific_organization', 'aps.org': 'scientific_organization',
  'iop.org': 'scientific_organization', 'nobelprize.org': 'scientific_organization', 'who.int': 'intergovernmental',
  'un.org': 'intergovernmental', 'esa.int': 'intergovernmental', 'cern.ch': 'scientific_organization',
  'smithsonianmag.com': 'museum_archive', 'si.edu': 'museum_archive', 'britishmuseum.org': 'museum_archive',
  'reuters.com': 'established_news', 'apnews.com': 'established_news', 'bbc.co.uk': 'established_news', 'bbc.com': 'established_news',
  'nytimes.com': 'established_news', 'theguardian.com': 'established_news', 'washingtonpost.com': 'established_news',
  'economist.com': 'established_news', 'ft.com': 'established_news', 'npr.org': 'established_news', 'pbs.org': 'established_news',
  'scientificamerican.com': 'specialist_publication', 'newscientist.com': 'specialist_publication',
};

const ACCEPTABLE_DOMAINS: Record<string, SourceCategory> = {
  'wikipedia.org': 'reference', 'britannica.com': 'reference', 'history.com': 'reference', 'nationalgeographic.com': 'specialist_publication',
  'sciencedaily.com': 'specialist_publication', 'phys.org': 'specialist_publication', 'livescience.com': 'specialist_publication',
  'space.com': 'specialist_publication', 'arstechnica.com': 'specialist_publication', 'wired.com': 'specialist_publication',
  'theatlantic.com': 'established_news', 'time.com': 'established_news', 'cnn.com': 'established_news', 'cbsnews.com': 'established_news',
  'nbcnews.com': 'established_news', 'abcnews.go.com': 'established_news', 'latimes.com': 'established_news', 'wsj.com': 'established_news',
  'bloomberg.com': 'established_news', 'theverge.com': 'specialist_publication', 'engineering.com': 'specialist_publication',
  'asce.org': 'scientific_organization', 'arxiv.org': 'academic',
};

/** Known misinformation, pseudo-science, and partisan/religious advocacy outlets. */
const REJECTED_DOMAINS: Record<string, SourceCategory> = {
  'icr.org': 'religious_advocacy', 'answersingenesis.org': 'religious_advocacy', 'creation.com': 'religious_advocacy',
  'evolutionnews.org': 'advocacy', 'naturalnews.com': 'advocacy', 'infowars.com': 'advocacy', 'beforeitsnews.com': 'content_farm',
  'globalresearch.ca': 'advocacy', 'zerohedge.com': 'advocacy', 'thegatewaypundit.com': 'advocacy', 'breitbart.com': 'advocacy',
  'mercola.com': 'advocacy', 'facebook.com': 'user_generated', 'fb.com': 'user_generated', 'instagram.com': 'user_generated',
  'tiktok.com': 'user_generated', 'twitter.com': 'user_generated', 'x.com': 'user_generated', 'reddit.com': 'user_generated',
  'quora.com': 'user_generated', 'pinterest.com': 'user_generated', 'youtube.com': 'user_generated', 'linkedin.com': 'user_generated',
  'tumblr.com': 'user_generated', 'threads.net': 'user_generated', 'answers.com': 'content_farm', 'ehow.com': 'content_farm',
  'wikihow.com': 'content_farm', 'fandom.com': 'user_generated',
};

/** Self-publishing platforms: content quality depends entirely on the author. */
const QUESTIONABLE_DOMAINS: Record<string, SourceCategory> = {
  'medium.com': 'blog_personal', 'substack.com': 'blog_personal', 'blogspot.com': 'blog_personal', 'wordpress.com': 'blog_personal',
  'wixsite.com': 'blog_personal', 'weebly.com': 'blog_personal', 'forbes.com': 'blog_personal', 'hubpages.com': 'blog_personal',
};

/** Fixed mapping applied to LLM category judgments for domains without a rule. */
export const CATEGORY_TIER: Record<SourceCategory, SourceCredibility> = {
  government: 'ACCEPTABLE',
  intergovernmental: 'ACCEPTABLE',
  academic: 'ACCEPTABLE',
  scientific_organization: 'ACCEPTABLE',
  museum_archive: 'ACCEPTABLE',
  established_news: 'ACCEPTABLE',
  reference: 'ACCEPTABLE',
  specialist_publication: 'ACCEPTABLE',
  commercial: 'QUESTIONABLE',
  blog_personal: 'QUESTIONABLE',
  unknown: 'QUESTIONABLE',
  advocacy: 'REJECTED',
  religious_advocacy: 'REJECTED',
  user_generated: 'REJECTED',
  content_farm: 'REJECTED',
};

function matchDomain(host: string, table: Record<string, SourceCategory>): [string, SourceCategory] | null {
  const h = host.toLowerCase().replace(/^www\./, '');
  for (const [d, cat] of Object.entries(table)) if (h === d || h.endsWith(`.${d}`)) return [d, cat];
  return null;
}

/** Deterministic policy. Returns null when no rule applies (the domain needs an assessment). */
export function ruleAssessment(url: string): SourceAssessment | null {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return { tier: 'REJECTED', category: 'unknown', method: 'rule', conflictOfInterest: false, reason: 'unparseable URL' };
  }
  const rej = matchDomain(host, REJECTED_DOMAINS);
  if (rej) return { tier: 'REJECTED', category: rej[1], method: 'rule', conflictOfInterest: false, reason: `deny-listed domain (${rej[0]})` };
  const q = matchDomain(host, QUESTIONABLE_DOMAINS);
  if (q) return { tier: 'QUESTIONABLE', category: q[1], method: 'rule', conflictOfInterest: false, reason: `self-publishing platform (${q[0]})` };
  const hi = matchDomain(host, HIGH_DOMAINS);
  if (hi) return { tier: 'HIGH', category: hi[1], method: 'rule', conflictOfInterest: false, reason: `allow-listed institution (${hi[0]})` };
  const suffix = HIGH_SUFFIXES.find((s) => host.endsWith(s));
  if (suffix) {
    const cat: SourceCategory = suffix.includes('edu') || suffix.startsWith('.ac.') ? 'academic' : suffix === '.int' || suffix === '.europa.eu' ? 'intergovernmental' : 'government';
    return { tier: 'HIGH', category: cat, method: 'rule', conflictOfInterest: false, reason: `public/academic domain (${suffix})` };
  }
  const ok = matchDomain(host, ACCEPTABLE_DOMAINS);
  if (ok) return { tier: 'ACCEPTABLE', category: ok[1], method: 'rule', conflictOfInterest: false, reason: `allow-listed publication (${ok[0]})` };
  return null;
}

/** Maps an LLM category judgment for an unknown domain to a tier (never HIGH). */
export function assessedTier(category: SourceCategory, conflictOfInterest: boolean): SourceCredibility {
  const t = CATEGORY_TIER[category];
  return conflictOfInterest && t === 'ACCEPTABLE' ? 'QUESTIONABLE' : t;
}

const AssessmentOutputSchema = z.object({
  sources: z.array(
    z.object({
      ref: z.string(),
      category: SourceCategorySchema,
      conflictOfInterest: z.boolean(),
      reason: z.string().default(''),
    })
  ),
});

/** Assess every source: rules first, one batched LLM category call for the rest. */
export async function assessSources(
  llm: LLMProvider,
  sources: Array<{ ref: string; url: string; title: string; excerpt: string }>
): Promise<Map<string, SourceAssessment>> {
  const out = new Map<string, SourceAssessment>();
  const unknown: typeof sources = [];
  for (const s of sources) {
    const r = ruleAssessment(s.url);
    if (r) out.set(s.ref, r);
    else unknown.push(s);
  }
  if (unknown.length === 0) return out;
  const refs = new Set(unknown.map((u) => u.ref));
  const res = await llm.generateStructured({
    task: 'source_credibility',
    system: 'You classify web sources by who publishes them. Judge the publisher, not whether the page content is true.',
    prompt: `Classify the publisher of each source.

Categories: ${SourceCategorySchema.options.join(', ')}.
- commercial: company/product/marketing sites, sellers, agencies.
- advocacy / religious_advocacy: organisations promoting a cause, ideology or religious position.
- content_farm: SEO/aggregator sites with thin or copied content.
- unknown: you cannot tell who publishes it.
conflictOfInterest: true if the publisher has a direct stake in the topic (e.g. a company writing about its own product).

${unknown.map((u) => `[${u.ref}] ${u.url}\n     title: ${u.title}\n     excerpt: ${u.excerpt.slice(0, 300).replace(/\s+/g, ' ')}`).join('\n')}`,
    schemaHint: '{"sources":[{"ref":"S1","category":"specialist_publication","conflictOfInterest":false,"reason":"string"}]}',
    schema: AssessmentOutputSchema,
    validate: (v) => {
      const seen = new Set(v.sources.map((s) => s.ref));
      const missing = [...refs].filter((r) => !seen.has(r));
      return missing.length ? [`missing classifications for ${missing.join(', ')}`] : [];
    },
    temperature: 0,
    maxTokens: 800,
  });
  for (const s of res.content.sources) {
    if (!refs.has(s.ref)) continue;
    const tier = assessedTier(s.category, s.conflictOfInterest);
    out.set(s.ref, { tier, category: s.category, method: 'assessed', conflictOfInterest: s.conflictOfInterest, reason: s.reason || `assessed as ${s.category}` });
  }
  return out;
}

export const sourceTier = (s: SourceReference): SourceCredibility => s.credibility?.tier ?? 'QUESTIONABLE';

export interface ClaimSourceStatus {
  bestTier: SourceCredibility | null;
  /** Supported by at least one HIGH/ACCEPTABLE source. */
  citable: boolean;
  /** Best support is QUESTIONABLE: usable only after human review. */
  reviewRequired: boolean;
  /** Only REJECTED sources (or none) support it: never usable. */
  rejected: boolean;
  citableSourceIds: string[];
}

export function claimSourceStatus(claim: Claim, sources: SourceReference[]): ClaimSourceStatus {
  const byId = new Map(sources.map((s) => [s.id, s]));
  const supporting = claim.sourceIds.map((id) => byId.get(id)).filter((s): s is SourceReference => Boolean(s));
  if (supporting.length === 0) return { bestTier: null, citable: false, reviewRequired: false, rejected: true, citableSourceIds: [] };
  const best = supporting.map(sourceTier).sort((a, b) => rank[b] - rank[a])[0];
  return {
    bestTier: best,
    citable: isCitable(best),
    reviewRequired: best === 'QUESTIONABLE',
    rejected: best === 'REJECTED',
    citableSourceIds: supporting.filter((s) => isCitable(sourceTier(s))).map((s) => s.id),
  };
}
