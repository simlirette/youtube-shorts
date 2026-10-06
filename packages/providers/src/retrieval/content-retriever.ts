import * as cheerio from 'cheerio';
import { httpRequest, InvalidResponseError, PipelineError, logger, safeUrl } from '@shorts/core';
import type { FetchLike } from '@shorts/core';
import type { PageRetriever, RetrievedSourceContent } from '../interfaces.js';

const PRIVATE_HOST = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|0\.0\.0\.0|\[::1\]|\[fc|\[fd)/i;

/**
 * Fetches a public web page and extracts readable text. External content is untrusted: private
 * network targets are refused, size is capped, and the whole request is bounded by a timeout.
 * Failures are returned as data (with `error`) because a missing page is an expected outcome.
 */
export class SourceContentRetriever implements PageRetriever {
  constructor(private readonly opts: { timeoutMs: number; maxBytes?: number; maxChars?: number; fetchImpl?: FetchLike } = { timeoutMs: 15_000 }) {}

  async retrieveUrl(url: string): Promise<RetrievedSourceContent> {
    const retrievedAt = new Date().toISOString();
    const fail = (statusCode: number, error: string): RetrievedSourceContent => ({ url, title: '', cleanText: '', contentLength: 0, statusCode, retrievedAt, error });
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return fail(0, 'invalid URL');
    }
    if (!['http:', 'https:'].includes(parsed.protocol)) return fail(0, `unsupported protocol ${parsed.protocol}`);
    if (PRIVATE_HOST.test(parsed.hostname)) return fail(0, 'private network address refused');

    const maxBytes = this.opts.maxBytes ?? 3_000_000;
    try {
      const res = await httpRequest(
        url,
        {
          headers: {
            'User-Agent': 'Mozilla/5.0 (compatible; ShortsResearchBot/1.0; +https://example.invalid/bot)',
            Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9',
          },
        },
        { provider: 'web', operation: 'retrieve', timeoutMs: this.opts.timeoutMs, maxAttempts: 2, fetchImpl: this.opts.fetchImpl },
        async (r) => {
          const ct = r.headers.get('content-type') ?? '';
          if (!ct.includes('text/html') && !ct.includes('text/plain') && !ct.includes('xhtml')) {
            throw new InvalidResponseError('web', `non-text content-type ${ct}`);
          }
          const buf = Buffer.from(await r.arrayBuffer());
          if (buf.length > maxBytes) throw new InvalidResponseError('web', `page too large (${buf.length} bytes)`);
          return { html: buf.toString('utf-8'), contentType: ct };
        }
      );
      const { title, text } = SourceContentRetriever.extractText(res.data.html, res.data.contentType);
      const maxChars = this.opts.maxChars ?? 20_000;
      const cleanText = text.length > maxChars ? text.slice(0, maxChars) : text;
      return { url, title, cleanText, contentLength: cleanText.length, statusCode: res.status, retrievedAt };
    } catch (err) {
      const msg = err instanceof PipelineError ? err.message : (err as Error).message;
      logger.debug(`Source retrieval failed for ${safeUrl(url)}: ${msg}`, { stage: 'RESEARCH' });
      return fail(0, msg);
    }
  }

  static extractText(html: string, contentType = 'text/html'): { title: string; text: string } {
    if (contentType.includes('text/plain')) return { title: '', text: html.replace(/\s+/g, ' ').trim() };
    const $ = cheerio.load(html);
    $('script, style, noscript, nav, footer, header, svg, iframe, form, button, aside').remove();
    const title = $('title').first().text().trim() || $('h1').first().text().trim();
    const paragraphs: string[] = [];
    $('p, li, h1, h2, h3, blockquote, td').each((_, el) => {
      const t = $(el).text().replace(/\s+/g, ' ').trim();
      if (t.length > 30) paragraphs.push(t);
    });
    let text = paragraphs.join('\n');
    if (text.length < 200) text = $('body').text().replace(/\s+/g, ' ').trim();
    return { title, text };
  }
}
