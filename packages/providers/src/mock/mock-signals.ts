import type { SignalsProvider, VideoSignal } from '../interfaces.js';

/**
 * Deterministic audience signals for offline tests. Questions about "planes" and "ships" have big
 * long-form demand and no Shorts; questions about "windows" are already well covered by Shorts.
 */
export class MockSignalsProvider implements SignalsProvider {
  readonly name = 'mock-signals';
  readonly searches: string[] = [];

  constructor(private readonly overrides: { suggest?: (p: string) => string[]; search?: (q: string) => VideoSignal[] } = {}) {}

  async suggest(prefix: string): Promise<string[]> {
    if (this.overrides.suggest) return this.overrides.suggest(prefix);
    const p = prefix.trim();
    if (/ [a-z]$/.test(p)) return [];
    if (p.startsWith('why do planes')) return ['why do planes turn after takeoff', 'why do planes dump fuel before landing', 'why do planes have round windows', 'why do planes song lyrics'];
    if (p.startsWith('why do ships')) return ['why do ships have bulbous bows', 'why do ships float'];
    return [];
  }

  async searchVideos(query: string): Promise<VideoSignal[]> {
    this.searches.push(query);
    if (this.overrides.search) return this.overrides.search(query);
    const long = (id: string, views: number): VideoSignal => ({ id, title: `${query} explained`, views, durationSeconds: 600, channel: 'Long Channel' });
    const short = (id: string, views: number): VideoSignal => ({ id, title: `${query} #shorts`, views, durationSeconds: 45, channel: 'Shorts Channel' });
    if (query.includes('round windows')) return [long('a', 16_000_000), short('b', 675_000), short('c', 148_000)];
    if (query.includes('float')) return [long('d', 4_000_000), short('e', 829_000), short('f', 365_000), short('g', 50_000)];
    return [long('h', 6_800_000), long('i', 2_500_000), short('j', 120)];
  }

  async videoStats(ids: string[]) {
    return ids.map((id) => ({ id, views: 1000, likes: 50, comments: 3 }));
  }
}
