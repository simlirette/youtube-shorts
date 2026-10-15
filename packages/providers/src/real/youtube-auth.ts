import http from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { AuthenticationError, ConfigurationError, httpJson } from '@shorts/core';
import type { FetchLike } from '@shorts/core';

/** Scopes: upload, read own channel/videos, and read YouTube Analytics (engaged views, retention). */
export const YOUTUBE_SCOPES = [
  'https://www.googleapis.com/auth/youtube.upload',
  'https://www.googleapis.com/auth/youtube.readonly',
  'https://www.googleapis.com/auth/yt-analytics.readonly',
];

const b64url = (b: Buffer) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export interface OAuthClient {
  clientId: string;
  clientSecret: string;
}

/** Consent URL for the installed-app (loopback) flow with PKCE. */
export function buildConsentUrl(client: OAuthClient, redirectUri: string, state: string, codeChallenge: string): string {
  const p = new URLSearchParams({
    client_id: client.clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: YOUTUBE_SCOPES.join(' '),
    access_type: 'offline',
    prompt: 'consent',
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${p.toString()}`;
}

export async function exchangeCode(client: OAuthClient, code: string, redirectUri: string, codeVerifier: string, fetchImpl?: FetchLike): Promise<{ refreshToken: string; scope: string }> {
  const res = await httpJson<{ refresh_token?: string; scope?: string }>(
    'https://oauth2.googleapis.com/token',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: client.clientId, client_secret: client.clientSecret, code, code_verifier: codeVerifier, grant_type: 'authorization_code', redirect_uri: redirectUri }).toString(),
    },
    { provider: 'google-oauth', operation: 'code_exchange', timeoutMs: 30_000, maxAttempts: 1, fetchImpl }
  );
  if (!res.data.refresh_token) throw new AuthenticationError('google-oauth', 'no refresh_token returned (remove the app at myaccount.google.com/permissions and retry; consent must be re-granted)');
  return { refreshToken: res.data.refresh_token, scope: res.data.scope ?? '' };
}

/** Exchanges a refresh token for a short-lived access token (kept in memory only). */
export async function accessTokenFor(client: OAuthClient, refreshToken: string, fetchImpl?: FetchLike): Promise<string> {
  const res = await httpJson<{ access_token?: string }>(
    'https://oauth2.googleapis.com/token',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: client.clientId, client_secret: client.clientSecret, refresh_token: refreshToken, grant_type: 'refresh_token' }).toString(),
    },
    { provider: 'google-oauth', operation: 'refresh', timeoutMs: 30_000, maxAttempts: 2, fetchImpl }
  );
  if (!res.data.access_token) throw new AuthenticationError('google-oauth', 'token refresh returned no access_token');
  return res.data.access_token;
}

/**
 * Runs the loopback OAuth flow: starts a local server on 127.0.0.1, prints the consent URL via
 * `onUrl`, waits for Google's redirect and returns the refresh token. Times out after 5 minutes.
 */
export async function runLoopbackAuth(client: OAuthClient, onUrl: (url: string) => void, opts: { port?: number; timeoutMs?: number } = {}): Promise<{ refreshToken: string; scope: string }> {
  if (!client.clientId || !client.clientSecret) throw new ConfigurationError('YOUTUBE_CLIENT_ID and YOUTUBE_CLIENT_SECRET are required (Google Cloud → APIs & Services → Credentials → OAuth client ID → Desktop app)');
  const state = b64url(randomBytes(16));
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash('sha256').update(verifier).digest());
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    const timer = setTimeout(() => {
      server.close();
      reject(new AuthenticationError('google-oauth', 'timed out waiting for consent'));
    }, opts.timeoutMs ?? 300_000);
    server.on('request', async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (url.pathname !== '/callback') {
        res.writeHead(404).end();
        return;
      }
      const done = (status: number, msg: string) => res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' }).end(msg);
      try {
        if (url.searchParams.get('state') !== state) throw new AuthenticationError('google-oauth', 'state mismatch (possible CSRF); retry');
        const err = url.searchParams.get('error');
        if (err) throw new AuthenticationError('google-oauth', `consent denied: ${err}`);
        const code = url.searchParams.get('code');
        if (!code) throw new AuthenticationError('google-oauth', 'no authorization code in redirect');
        const addr = server.address() as { port: number };
        const tokens = await exchangeCode(client, code, `http://127.0.0.1:${addr.port}/callback`, verifier);
        done(200, 'YouTube access granted. You can close this tab and return to the terminal.');
        clearTimeout(timer);
        server.close();
        resolve(tokens);
      } catch (e) {
        done(400, `Authorization failed: ${(e as Error).message}`);
        clearTimeout(timer);
        server.close();
        reject(e);
      }
    });
    server.listen(opts.port ?? 0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      onUrl(buildConsentUrl(client, `http://127.0.0.1:${addr.port}/callback`, state, challenge));
    });
  });
}
