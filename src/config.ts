import { AppError } from './errors.js';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

export type LogLevel = 'error' | 'warn' | 'info' | 'debug';

export interface AppConfig {
  readonly apiUrl: URL;
  readonly apiToken?: string;
  readonly apiTimeoutMs: number;
  readonly allowNonLoopbackUrl: boolean;
  /**
   * True when the Super Productivity build honours `isIgnoreShortSyntax` and
   * stores new titles literally. Off by default: 19.0.x and older parse short
   * syntax out of new titles, so such titles are rejected instead.
   */
  readonly literalTitles: boolean;
  /** Registers the permanent delete_task tool. Off by default. */
  readonly enableDelete: boolean;
  readonly logLevel: LogLevel;
}

const parseBoolean = (name: string, value: string | undefined, defaultValue: boolean): boolean => {
  if (value === undefined || value.trim() === '') return defaultValue;
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  throw new AppError('CONFIGURATION_ERROR', `${name} must be a boolean`);
};

const parseTimeout = (value: string | undefined): number => {
  if (value === undefined || value.trim() === '') return 15_000;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1_000 || parsed > 60_000) {
    throw new AppError(
      'CONFIGURATION_ERROR',
      'SP_API_TIMEOUT_MS must be an integer between 1000 and 60000',
    );
  }
  return parsed;
};

const parseLogLevel = (value: string | undefined): LogLevel => {
  const level = (value?.trim().toLowerCase() || 'warn') as LogLevel;
  if (!['error', 'warn', 'info', 'debug'].includes(level)) {
    throw new AppError('CONFIGURATION_ERROR', 'SP_LOG_LEVEL must be error, warn, info, or debug');
  }
  return level;
};

const parseApiUrl = (value: string | undefined, allowNonLoopbackUrl: boolean): URL => {
  const raw = (value?.trim() || 'http://127.0.0.1:3876').replace(/\/+$/, '');
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new AppError('CONFIGURATION_ERROR', 'SP_API_URL must be an absolute http(s) URL');
  }

  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new AppError('CONFIGURATION_ERROR', 'SP_API_URL must use http or https');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new AppError(
      'CONFIGURATION_ERROR',
      'SP_API_URL must not contain credentials, query parameters, or fragments',
    );
  }
  if (!allowNonLoopbackUrl && !LOOPBACK_HOSTS.has(url.hostname.toLowerCase())) {
    throw new AppError(
      'CONFIGURATION_ERROR',
      'SP_API_URL must point to localhost; set SP_ALLOW_NON_LOOPBACK_URL=true only for a trusted local proxy',
    );
  }

  return url;
};

export const loadConfig = (env: NodeJS.ProcessEnv = process.env): AppConfig => {
  const allowNonLoopbackUrl = parseBoolean(
    'SP_ALLOW_NON_LOOPBACK_URL',
    env.SP_ALLOW_NON_LOOPBACK_URL,
    false,
  );
  const token = env.SP_API_TOKEN?.trim();

  return {
    apiUrl: parseApiUrl(env.SP_API_URL, allowNonLoopbackUrl),
    ...(token ? { apiToken: token } : {}),
    apiTimeoutMs: parseTimeout(env.SP_API_TIMEOUT_MS),
    allowNonLoopbackUrl,
    literalTitles: parseBoolean('SP_LITERAL_TITLES', env.SP_LITERAL_TITLES, false),
    enableDelete: parseBoolean('SP_ENABLE_DELETE', env.SP_ENABLE_DELETE, false),
    logLevel: parseLogLevel(env.SP_LOG_LEVEL),
  };
};
