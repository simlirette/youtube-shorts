import fs from 'node:fs';
import path from 'node:path';
import { QuotaExceededError } from './errors.js';

/**
 * Free-tier guards. Providers on a free plan have hard quotas (requests per day, credits per
 * month); going over either fails the call or starts billing. These counters live on disk so every
 * process on this machine shares them, and a call that would exceed the budget is refused with
 * QUOTA_EXCEEDED *before* it is sent. They only count this machine's usage: other tools using the
 * same key are not seen, so budgets should keep a margin below the provider's published limit.
 */

export type BudgetPeriod = 'day' | 'month';

export interface UsageBudgetOptions {
  /** JSON file holding the counters (created on first use). */
  file: string;
  provider: string;
  /** Units allowed per period (requests, credits). 0 or less disables the budget. */
  limit: number;
  period: BudgetPeriod;
  /** Time zone the period resets in (Gemini: America/Los_Angeles; Tavily: UTC). */
  timeZone: string;
  unit: string;
  now?: () => Date;
}

interface BudgetFile {
  [key: string]: { period: string; used: number };
}

export function periodKey(date: Date, period: BudgetPeriod, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  return period === 'day' ? `${get('year')}-${get('month')}-${get('day')}` : `${get('year')}-${get('month')}`;
}

export class UsageBudget {
  constructor(private readonly o: UsageBudgetOptions) {}

  private read(): BudgetFile {
    try {
      return JSON.parse(fs.readFileSync(this.o.file, 'utf-8')) as BudgetFile;
    } catch {
      return {};
    }
  }

  /** Units used in the current period. */
  used(): number {
    const key = periodKey((this.o.now ?? (() => new Date()))(), this.o.period, this.o.timeZone);
    const e = this.read()[this.o.provider];
    return e && e.period === key ? e.used : 0;
  }

  remaining(): number {
    return this.o.limit > 0 ? Math.max(0, this.o.limit - this.used()) : Infinity;
  }

  /** Records `units` against the period, or throws QUOTA_EXCEEDED without recording anything. */
  reserve(units = 1): void {
    if (this.o.limit <= 0) return;
    const key = periodKey((this.o.now ?? (() => new Date()))(), this.o.period, this.o.timeZone);
    const all = this.read();
    const e = all[this.o.provider];
    const used = e && e.period === key ? e.used : 0;
    if (used + units > this.o.limit) {
      throw new QuotaExceededError(
        this.o.provider,
        `free-tier budget reached: ${used}/${this.o.limit} ${this.o.unit} this ${this.o.period} (${key}, ${this.o.timeZone}); refusing the call instead of exceeding the free quota`
      );
    }
    all[this.o.provider] = { period: key, used: used + units };
    fs.mkdirSync(path.dirname(this.o.file), { recursive: true });
    fs.writeFileSync(this.o.file, JSON.stringify(all, null, 2));
  }
}

/** Rolling one-minute request window (requests per minute caps). Waits rather than failing. */
export class RollingMinuteLimiter {
  private stamps: number[] = [];
  constructor(
    private readonly perMinute: number,
    private readonly now: () => number = Date.now,
    private readonly sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
  ) {}

  /** Resolves when a request may be sent; returns the milliseconds waited. */
  async acquire(): Promise<number> {
    if (this.perMinute <= 0) return 0;
    let waited = 0;
    for (;;) {
      const t = this.now();
      while (this.stamps.length && t - this.stamps[0] >= 60_000) this.stamps.shift();
      if (this.stamps.length < this.perMinute) {
        this.stamps.push(t);
        return waited;
      }
      const ms = 60_000 - (t - this.stamps[0]) + 50;
      waited += ms;
      await this.sleep(ms);
    }
  }
}
