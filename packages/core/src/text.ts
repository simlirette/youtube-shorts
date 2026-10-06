/** Deterministic text utilities shared by validation, verification and timing. */

/** Whitespace tokens exactly as narration is split for TTS alignment. */
export function tokenizeWords(text: string): string[] {
  return text.trim().split(/\s+/).filter((t) => t.length > 0);
}

/** Spoken words: whitespace tokens that contain at least one letter or digit. */
export function countWords(text: string): number {
  return tokenizeWords(text).filter((t) => /[\p{L}\p{N}]/u.test(t)).length;
}

/** Lowercase, unify typography, strip punctuation, collapse whitespace. Used for quote matching. */
export function normalizeForMatch(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[‘’‚‛′]/g, "'")
    .replace(/[“”„″]/g, '"')
    .replace(/[‐-―]/g, '-')
    .replace(/(\d),(\d{3})/g, '$1$2')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

const NUMBER_WORDS: Record<string, string> = {
  zero: '0', one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9',
  ten: '10', eleven: '11', twelve: '12', thirteen: '13', fourteen: '14', fifteen: '15', sixteen: '16',
  seventeen: '17', eighteen: '18', nineteen: '19', twenty: '20', thirty: '30', forty: '40', fifty: '50',
  sixty: '60', seventy: '70', eighty: '80', ninety: '90', hundred: '100', thousand: '1000',
};

/**
 * Numeric facts in a text (digits, with thousands separators removed). Spelled-out numbers are
 * normalised when `includeWords` is true so "forty" in a claim can match "40" in evidence.
 */
export function extractNumbers(text: string, includeWords = false): string[] {
  const out = new Set<string>();
  const digits = text.replace(/(\d),(\d{3})/g, '$1$2').match(/(?<![\p{L}\d.]|\p{L}-)\d+(?:\.\d+)?(?![\p{L}\d])/gu) ?? [];
  for (const d of digits) out.add(String(Number(d)));
  if (includeWords) {
    for (const w of normalizeForMatch(text).split(' ')) {
      if (NUMBER_WORDS[w]) out.add(NUMBER_WORDS[w]);
    }
  }
  return [...out];
}

const STOPWORDS = new Set(
  (
    'a an the of in on at to for from by with and or but is are was were be been being that this these those it its ' +
    'how why what when where who whom which as into over under about after before than then so such very can could ' +
    'would should will just not no nor do does did done has have had their his her they them we you your our out up ' +
    'down off more most less least story tale truth secret mystery strange bizarre incredible untold real true day ' +
    'year years one two first last behind inside'
  ).split(' ')
);

function stem(token: string): string {
  if (token.length > 4 && token.endsWith('ies')) return token.slice(0, -3) + 'y';
  if (token.length > 3 && token.endsWith('es') && !token.endsWith('ses')) return token.slice(0, -2);
  if (token.length > 3 && token.endsWith('s') && !token.endsWith('ss')) return token.slice(0, -1);
  return token;
}

/** Content-bearing tokens (stopwords and very short tokens removed, light stemming). */
export function significantTokens(text: string): string[] {
  return normalizeForMatch(text)
    .split(' ')
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t))
    .map(stem);
}

export function jaccard(a: Iterable<string>, b: Iterable<string>): number {
  const sa = new Set(a);
  const sb = new Set(b);
  if (sa.size === 0 && sb.size === 0) return 1;
  let inter = 0;
  for (const x of sa) if (sb.has(x)) inter++;
  return inter / (sa.size + sb.size - inter);
}

/** Overlap coefficient: |A∩B| / min(|A|,|B|). Detects "same subject, longer title". */
export function overlapCoefficient(a: Iterable<string>, b: Iterable<string>): number {
  const sa = new Set(a);
  const sb = new Set(b);
  if (sa.size === 0 || sb.size === 0) return 0;
  let inter = 0;
  for (const x of sa) if (sb.has(x)) inter++;
  return inter / Math.min(sa.size, sb.size);
}

/** Stable dedupe key: sorted unique significant tokens. */
export function dedupeKey(text: string): string {
  return [...new Set(significantTokens(text))].sort().join(' ');
}
