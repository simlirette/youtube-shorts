import { execFile } from 'node:child_process';
import { ConfigurationError, InvalidResponseError, ProviderUnavailableError } from '@shorts/core';
import type { ProviderContext, SignalsProvider, VideoSignal } from '../interfaces.js';

/** Runs a command and returns stdout; injectable for tests. */
export type CommandRunner = (cmd: string, args: string[], timeoutMs: number) => Promise<string>;

const defaultRunner: CommandRunner = (cmd, args, timeoutMs) =>
  new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 64 * 1024 * 1024, timeout: timeoutMs, windowsHide: true }, (err, stdout, stderr) => {
      if (err) {
        const e = err as NodeJS.ErrnoException;
        if (e.code === 'ENOENT') return reject(new ConfigurationError(`${cmd} not found; install yt-dlp (pipx install yt-dlp) or set YTDLP_PATH`));
        return reject(new ProviderUnavailableError('yt-dlp', `${e.message.slice(0, 200)} ${String(stderr).slice(0, 200)}`));
      }
      resolve(stdout);
    });
  });

interface FlatEntry {
  id?: string;
  title?: string;
  view_count?: number | null;
  like_count?: number | null;
  comment_count?: number | null;
  duration?: number | null;
  channel?: string | null;
  uploader?: string | null;
}

/**
 * Free, key-less audience signals:
 * - YouTube search autocomplete (public suggest endpoint, ds=yt)
 * - YouTube search results and video counters via yt-dlp (flat extraction, no downloads)
 */
export class YouTubeSignalsProvider implements SignalsProvider {
  readonly name = 'youtube-signals';

  constructor(
    private readonly opts: { ytdlpPath: string; timeoutMs: number },
    private readonly ctx: ProviderContext = {},
    private readonly runner: CommandRunner = defaultRunner
  ) {}

  async suggest(prefix: string): Promise<string[]> {
    const fetchImpl = this.ctx.fetchImpl ?? fetch;
    const url = `https://suggestqueries.google.com/complete/search?client=firefox&ds=yt&hl=en&q=${encodeURIComponent(prefix)}`;
    let text: string;
    try {
      const res = await fetchImpl(url, { signal: AbortSignal.timeout(this.opts.timeoutMs) });
      if (!res.ok) throw new ProviderUnavailableError(this.name, `suggest HTTP ${res.status}`);
      text = await res.text();
    } catch (e) {
      throw e instanceof ProviderUnavailableError ? e : new ProviderUnavailableError(this.name, `suggest failed: ${(e as Error).message}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new InvalidResponseError(this.name, 'suggest returned non-JSON');
    }
    if (!Array.isArray(parsed) || !Array.isArray(parsed[1])) throw new InvalidResponseError(this.name, 'unexpected suggest shape');
    return (parsed[1] as unknown[]).filter((s): s is string => typeof s === 'string');
  }

  private async ytdlp(args: string[]): Promise<{ entries?: FlatEntry[] } & FlatEntry> {
    const out = await this.runner(this.opts.ytdlpPath, ['--no-warnings', '--no-update', ...args], this.opts.timeoutMs);
    try {
      return JSON.parse(out);
    } catch {
      throw new InvalidResponseError('yt-dlp', 'output was not JSON');
    }
  }

  async searchVideos(query: string, limit: number): Promise<VideoSignal[]> {
    const j = await this.ytdlp([`ytsearch${Math.max(1, Math.min(50, limit))}:${query}`, '--flat-playlist', '-J']);
    return (j.entries ?? [])
      .filter((e) => e.id)
      .map((e) => ({
        id: e.id!,
        title: e.title ?? '',
        views: typeof e.view_count === 'number' ? e.view_count : null,
        durationSeconds: typeof e.duration === 'number' ? e.duration : null,
        channel: e.channel ?? e.uploader ?? null,
      }));
  }

  async videoStats(ids: string[]): Promise<Array<{ id: string; views: number | null; likes: number | null; comments: number | null }>> {
    const out = [];
    for (const id of ids) {
      if (!/^[\w-]{6,20}$/.test(id)) throw new InvalidResponseError(this.name, `invalid video id "${id}"`);
      const j = await this.ytdlp([`https://www.youtube.com/shorts/${id}`, '-J', '--skip-download']);
      out.push({ id, views: j.view_count ?? null, likes: j.like_count ?? null, comments: j.comment_count ?? null });
    }
    return out;
  }
}
