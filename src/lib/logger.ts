import { pino, type Logger } from 'pino';
import type { Env } from '../config/env.js';

export function createLogger(env: Env): Logger {
  const base = { rail: 'identiti', env: env.NODE_ENV };
  if (env.NODE_ENV === 'development') {
    return pino({
      level: env.LOG_LEVEL,
      base,
      transport: { target: 'pino-pretty', options: { colorize: true } },
    });
  }
  return pino({ level: env.LOG_LEVEL, base });
}

export type { Logger };
