import { extractNumbers, normalizeForMatch } from '@shorts/core';

export interface QuoteLocation {
  found: boolean;
  /** Source in which the quote was actually located (may differ from the cited one). */
  sourceId?: string;
  method?: 'exact' | 'segments';
  reattributed: boolean;
}

const MIN_SEGMENT_CHARS = 15;

function containsInOrder(haystack: string, segments: string[]): boolean {
  let from = 0;
  for (const seg of segments) {
    const idx = haystack.indexOf(seg, from);
    if (idx < 0) return false;
    from = idx + seg.length;
  }
  return true;
}

function matchIn(normQuote: string, segments: string[], normText: string): QuoteLocation['method'] | null {
  if (normQuote.length >= MIN_SEGMENT_CHARS && normText.includes(normQuote)) return 'exact';
  if (segments.length > 1 && segments.every((s) => s.length >= MIN_SEGMENT_CHARS) && containsInOrder(normText, segments)) return 'segments';
  return null;
}

/**
 * Locate an evidence quote in the retrieved source texts. The cited source is checked first; if the
 * quote only exists in another source, the claim is re-attributed to the source that actually
 * contains it. Matching is punctuation/case-insensitive; elided quotes ("…") must match in order.
 */
export function locateQuote(quote: string, citedSourceId: string, sourceTexts: Map<string, string>): QuoteLocation {
  const normQuote = normalizeForMatch(quote);
  const segments = quote
    .split(/\.\.\.|…|\[\.\.\.\]/)
    .map((s) => normalizeForMatch(s))
    .filter((s) => s.length > 0);
  if (normQuote.length < MIN_SEGMENT_CHARS) return { found: false, reattributed: false };

  const normalizedTexts = new Map<string, string>();
  const norm = (id: string) => {
    if (!normalizedTexts.has(id)) normalizedTexts.set(id, normalizeForMatch(sourceTexts.get(id) ?? ''));
    return normalizedTexts.get(id)!;
  };

  if (sourceTexts.has(citedSourceId)) {
    const m = matchIn(normQuote, segments, norm(citedSourceId));
    if (m) return { found: true, sourceId: citedSourceId, method: m, reattributed: false };
  }
  for (const id of sourceTexts.keys()) {
    if (id === citedSourceId) continue;
    const m = matchIn(normQuote, segments, norm(id));
    if (m) return { found: true, sourceId: id, method: m, reattributed: true };
  }
  return { found: false, reattributed: false };
}

/** Every number stated in the claim must appear in the evidence (digits or spelled-out). */
export function numbersConsistent(claimText: string, evidence: string): { ok: boolean; missing: string[] } {
  const claimNums = extractNumbers(claimText, false);
  const evidenceNums = new Set(extractNumbers(evidence, true));
  const missing = claimNums.filter((n) => !evidenceNums.has(n));
  return { ok: missing.length === 0, missing };
}

/** Numbers (digits) spoken in narration that no supporting claim text or evidence contains. */
export function unsupportedNumbers(narration: string, supportingTexts: string[]): string[] {
  const allowed = new Set(supportingTexts.flatMap((t) => extractNumbers(t, true)));
  return extractNumbers(narration, false).filter((n) => !allowed.has(n));
}
