export interface Logger {
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
}

export const logger: Logger = {
  info: (message, context) => write('info', message, context),
  warn: (message, context) => write('warn', message, context),
  error: (message, context) => write('error', message, context),
};

function write(level: string, message: string, context?: Record<string, unknown>): void {
  process.stdout.write(
    `${JSON.stringify({ level, message, ...context, timestamp: new Date().toISOString() })}\n`,
  );
}

export function safeError(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown error';
}
