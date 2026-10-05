export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogContext {
  stage?: string;
  runId?: string;
  topicId?: string;
  scriptId?: string;
  renderId?: string;
  costUsd?: number;
  [key: string]: unknown;
}

class Logger {
  private level: LogLevel = 'info';
  private totalEstimatedCost: number = 0;

  constructor() {
    const envLevel = process.env.LOG_LEVEL as LogLevel;
    if (envLevel && ['debug', 'info', 'warn', 'error'].includes(envLevel)) {
      this.level = envLevel;
    }
  }

  private shouldLog(level: LogLevel): boolean {
    const levels: Record<LogLevel, number> = {
      debug: 10,
      info: 20,
      warn: 30,
      error: 40,
    };
    return levels[level] >= levels[this.level];
  }

  private formatMessage(level: LogLevel, message: string, context?: LogContext): string {
    const timestamp = new Date().toISOString();
    const stage = context?.stage ? `[${context.stage.toUpperCase()}]` : '[SYSTEM]';
    const ctxString = context && Object.keys(context).length > 0
      ? ` | ${JSON.stringify(context)}`
      : '';
    return `[${timestamp}] [${level.toUpperCase()}] ${stage} ${message}${ctxString}`;
  }

  debug(message: string, context?: LogContext): void {
    if (this.shouldLog('debug')) {
      console.debug(this.formatMessage('debug', message, context));
    }
  }

  info(message: string, context?: LogContext): void {
    if (this.shouldLog('info')) {
      console.log(this.formatMessage('info', message, context));
    }
  }

  warn(message: string, context?: LogContext): void {
    if (this.shouldLog('warn')) {
      console.warn(this.formatMessage('warn', message, context));
    }
  }

  error(message: string, error?: unknown, context?: LogContext): void {
    if (this.shouldLog('error')) {
      const errDetails = error instanceof Error
        ? { errorMessage: error.message, stack: error.stack }
        : { rawError: error };
      console.error(this.formatMessage('error', message, { ...context, ...errDetails }));
    }
  }

  trackCost(costUsd: number, reason: string, context?: LogContext): void {
    this.totalEstimatedCost += costUsd;
    this.info(`Cost incurred: $${costUsd.toFixed(4)} (${reason}) | Total: $${this.totalEstimatedCost.toFixed(4)}`, {
      ...context,
      costUsd,
      cumulativeCostUsd: this.totalEstimatedCost,
    });
  }

  getTotalCost(): number {
    return this.totalEstimatedCost;
  }
}

export const logger = new Logger();
