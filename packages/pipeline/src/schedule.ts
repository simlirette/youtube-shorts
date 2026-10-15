/**
 * Release scheduling: picks the next free daily slot ("HH:MM" in an IANA timezone) for a public
 * release. Pure functions, no clock or I/O — callers pass `now` and the slots already taken.
 */

/** Offset (ms) of `timeZone` from UTC at the given instant. */
function tzOffsetMs(instant: Date, timeZone: string): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
      .formatToParts(instant)
      .filter((p) => p.type !== 'literal')
      .map((p) => [p.type, Number(p.value)])
  );
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return asUtc - instant.getTime();
}

/** UTC instant of a wall-clock time in `timeZone` (DST-correct). */
export function zonedTimeToUtc(year: number, month: number, day: number, hour: number, minute: number, timeZone: string): Date {
  const guess = new Date(Date.UTC(year, month - 1, day, hour, minute));
  const first = new Date(guess.getTime() - tzOffsetMs(guess, timeZone));
  // Re-evaluate at the corrected instant in case the guess crossed a DST boundary.
  return new Date(guess.getTime() - tzOffsetMs(first, timeZone));
}

function localDate(instant: Date, timeZone: string): { y: number; m: number; d: number } {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
      .formatToParts(instant)
      .filter((x) => x.type !== 'literal')
      .map((x) => [x.type, Number(x.value)])
  );
  return { y: p.year, m: p.month, d: p.day };
}

/**
 * Next slot strictly after `now + minLeadMinutes` that is not already taken. Slots are compared
 * at minute precision. YouTube requires publishAt to be in the future.
 */
export function nextPublishSlot(now: Date, slots: string[], timeZone: string, taken: Date[], minLeadMinutes = 30, horizonDays = 60): Date {
  const parsed = slots
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => s.split(':').map(Number) as [number, number])
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (parsed.length === 0) throw new Error('no publish slots configured');
  const takenKeys = new Set(taken.map((t) => Math.floor(t.getTime() / 60_000)));
  const earliest = now.getTime() + minLeadMinutes * 60_000;
  const start = localDate(now, timeZone);
  for (let dayOffset = 0; dayOffset <= horizonDays; dayOffset++) {
    const base = new Date(Date.UTC(start.y, start.m - 1, start.d + dayOffset, 12));
    const { y, m, d } = { y: base.getUTCFullYear(), m: base.getUTCMonth() + 1, d: base.getUTCDate() };
    for (const [hh, mm] of parsed) {
      const at = zonedTimeToUtc(y, m, d, hh, mm, timeZone);
      if (at.getTime() >= earliest && !takenKeys.has(Math.floor(at.getTime() / 60_000))) return at;
    }
  }
  throw new Error(`no free publish slot within ${horizonDays} days`);
}
