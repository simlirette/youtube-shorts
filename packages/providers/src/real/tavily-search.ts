import { ConfigurationError, InvalidResponseError, UsageBudget, httpJson } from '@shorts/core';
import type { ProviderContext, SearchOptions, SearchProvider, SearchResultItem } from '../interfaces.js';

interface TavilyResponse {
  results?: Array<{ title?: string; url?: string; content?: string; raw_content?: string | null; published_date?: string }>;
}

export class TavilySearchProvider implements SearchProvider {
  readonly name = 'tavily';

  constructor(
    private readonly apiKey: string,
    private readonly opts: {
      timeoutMs: number;
      maxAttempts: number;
      searchDepth: 'basic' | 'advanced';
      usdPerCredit: number;
      /** Free plan: credits per calendar month (UTC) this machine may use; refuses beyond it. */
      monthlyCredits?: { limit: number; budgetFile: string };
    },
    private readonly ctx: ProviderContext = {}
  ) {
    if (!apiKey) throw new ConfigurationError('TAVILY_API_KEY is required for the Tavily provider');
    if (opts.monthlyCredits && opts.monthlyCredits.limit > 0) {
      this.budget = new UsageBudget({ file: opts.monthlyCredits.budgetFile, provider: 'tavily', limit: opts.monthlyCredits.limit, period: 'month', timeZone: 'UTC', unit: 'credits' });
    }
  }

  private readonly budget?: UsageBudget;

  async search(query: string, o: SearchOptions): Promise<SearchResultItem[]> {
    if (!query.trim()) throw new InvalidResponseError(this.name, 'empty search query');
    const started = Date.now();
    const credits = this.opts.searchDepth === 'advanced' ? 2 : 1;
    this.budget?.reserve(credits);
    try {
      const res = await httpJson<TavilyResponse>(
        'https://api.tavily.com/search',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` },
          body: JSON.stringify({
            query: query.slice(0, 400),
            search_depth: this.opts.searchDepth,
            max_results: o.maxResults,
            include_answer: false,
            include_raw_content: o.includeRawContent,
          }),
        },
        { provider: this.name, operation: 'search', timeoutMs: this.opts.timeoutMs, maxAttempts: this.opts.maxAttempts, fetchImpl: this.ctx.fetchImpl, sleep: this.ctx.sleep }
      );
      if (!Array.isArray(res.data.results)) throw new InvalidResponseError(this.name, 'response has no results array');
      const items: SearchResultItem[] = [];
      for (const r of res.data.results) {
        if (!r.url) continue;
        let domain: string;
        try {
          const u = new URL(r.url);
          if (!['http:', 'https:'].includes(u.protocol)) continue;
          domain = u.hostname.replace(/^www\./, '');
        } catch {
          continue;
        }
        items.push({
          title: r.title?.trim() || domain,
          url: r.url,
          snippet: r.content ?? '',
          sourceDomain: domain,
          publishedDate: r.published_date,
          rawContent: r.raw_content ?? undefined,
        });
      }
      this.ctx.observer?.({ provider: this.name, operation: 'search', status: 'OK', attempts: res.attempts, durationMs: Date.now() - started, costUsd: credits * this.opts.usdPerCredit, units: { credits, results: items.length } });
      return items;
    } catch (err) {
      this.ctx.observer?.({ provider: this.name, operation: 'search', status: 'ERROR', attempts: 1, durationMs: Date.now() - started, costUsd: 0, error: (err as Error).message });
      throw err;
    }
  }
}
