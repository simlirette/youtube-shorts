export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogContext {
  jobId?: string;
  stage?: string;
  provider?: string;
  operation?: string;
  [key: string]: unknown;
}

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const SECRET_KEY_PATTERN = /(api[_-]?key|token|secret|password|authorization|xi-api-key|cookie)/i;
const SECRET_VALUE_PATTERNS: RegExp[] = [
  /sk-[A-Za-z0-9_-]{16,}/g, // OpenAI
  /tvly-[A-Za-z0-9_-]{8,}/g, // Tavily
  /AIza[0-9A-Za-z_-]{20,}/g, // Google
  /([?&](?:key|api_key|apikey|access_token)=)[^&\s"']+/gi, // keys in query strings
  /(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/g,
];

/** Remove anything that looks like a credential from a string. */
export function redactString(input: string): string {
  let out = input;
  for (const re of SECRET_VALUE_PATTERNS) {
    out = out.replace(re, (_m, prefix?: string) => (typeof prefix === 'string' && prefix.length < 30 ? `${prefix}[REDACTED]` : '[REDACTED]'));
  }
  return out;
}

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[depth-limit]';
  if (typeof value === 'string') return redactString(value);
  if (value instanceof Error) return { name: value.name, message: redactString(value.message) };
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redact(v, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEY_PATTERN.test(k) && typeof v === 'string' ? '[REDACTED]' : redact(v, depth + 1);
    }
    return out;
  }
  return value;
}

export class Logger {
  private level: LogLevel;
  private format: 'text' | 'json';
  private totalEstimatedCost = 0;

  constructor(private readonly baseContext: LogContext = {}, opts?: { level?: LogLevel; format?: 'text' | 'json' }) {
    const envLevel = process.env.LOG_LEVEL as LogLevel | undefined;
    this.level = opts?.level ?? (envLevel && envLevel in LEVELS ? envLevel : 'info');
    this.format = opts?.format ?? (process.env.LOG_FORMAT === 'json' ? 'json' : 'text');
  }

  child(context: LogContext): Logger {
    const c = new Logger({ ...this.baseContext, ...context }, { level: this.level, format: this.format });
    return c;
  }

  setLevel(level: LogLevel): void {
    this.level = level;
  }

  private emit(level: LogLevel, message: string, context?: LogContext): void {
    if (LEVELS[level] < LEVELS[this.level]) return;
    const ctx = redact({ ...this.baseContext, ...(context ?? {}) }) as Record<string, unknown>;
    const msg = redactString(message);
    const ts = new Date().toISOString();
    let line: string;
    if (this.format === 'json') {
      line = JSON.stringify({ ts, level, msg, ...ctx });
    } else {
      const stage = typeof ctx.stage === 'string' ? `[${ctx.stage}]` : '';
      const job = typeof ctx.jobId === 'string' ? `[job ${ctx.jobId.slice(0, 8)}]` : '';
      const rest = { ...ctx };
      delete rest.stage;
      delete rest.jobId;
      const tail = Object.keys(rest).length ? ` | ${JSON.stringify(rest)}` : '';
      line = `[${ts}] [${level.toUpperCase()}]${job}${stage} ${msg}${tail}`;
    }
    const stream = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
    stream.write(line + '\n');
  }

  debug(message: string, context?: LogContext): void {
    this.emit('debug', message, context);
  }
  info(message: string, context?: LogContext): void {
    this.emit('info', message, context);
  }
  warn(message: string, context?: LogContext): void {
    this.emit('warn', message, context);
  }
  error(message: string, error?: unknown, context?: LogContext): void {
    const errCtx =
      error instanceof Error
        ? { errorName: error.name, errorMessage: error.message, ...(LEVELS[this.level] <= LEVELS.debug ? { stack: error.stack } : {}) }
        : error !== undefined
          ? { rawError: error }
          : {};
    this.emit('error', message, { ...context, ...errCtx });
  }

  trackCost(costUsd: number, reason: string, context?: LogContext): void {
    this.totalEstimatedCost += costUsd;
    this.debug(`Estimated cost $${costUsd.toFixed(5)} (${reason})`, { ...context, costUsd });
  }

  getTotalCost(): number {
    return this.totalEstimatedCost;
  }
}

export const logger = new Logger();
