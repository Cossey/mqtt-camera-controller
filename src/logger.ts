export type LogLevelName = 'error' | 'warn' | 'info' | 'debug';

const LOG_LEVEL_ORDER: Record<LogLevelName, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

function normalizeLogLevel(level?: string): LogLevelName | null {
  if (!level) return null;
  const v = level.trim().toLowerCase();
  if (v === 'error' || v === 'warn' || v === 'info' || v === 'debug') return v;
  return null;
}

let activeLogLevel: LogLevelName = normalizeLogLevel(process.env.LOG_LEVEL) || 'info';

export function setLogLevel(level?: string) {
  const normalized = normalizeLogLevel(level);
  if (!normalized) return;
  activeLogLevel = normalized;
}

export function getLogLevel(): LogLevelName {
  return activeLogLevel;
}

function shouldLog(level: LogLevelName): boolean {
  return LOG_LEVEL_ORDER[level] <= LOG_LEVEL_ORDER[activeLogLevel];
}

export function logError(message: string, ...args: unknown[]) {
  if (!shouldLog('error')) return;
  console.error(message, ...args);
}

export function logWarn(message: string, ...args: unknown[]) {
  if (!shouldLog('warn')) return;
  console.warn(message, ...args);
}

export function logInfo(message: string, ...args: unknown[]) {
  if (!shouldLog('info')) return;
  console.info(message, ...args);
}

export function logDebug(message: string, ...args: unknown[]) {
  if (!shouldLog('debug')) return;
  console.debug(message, ...args);
}
