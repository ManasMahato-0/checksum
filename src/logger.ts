import { pino } from 'pino';

// JSON lines in production (ship them to any log store); readable output in a dev terminal;
// silent under the test runner unless LOG_LEVEL asks otherwise.
const pretty = process.env.NODE_ENV !== 'production' && process.stdout.isTTY;

export const logger = pino({
  level: process.env.LOG_LEVEL ?? (process.env.VITEST ? 'silent' : 'info'),
  redact: {
    paths: ['req.headers.cookie', 'req.headers.authorization', 'res.headers["set-cookie"]'],
    censor: '[redacted]',
  },
  transport: pretty ? { target: 'pino-pretty', options: { translateTime: 'SYS:HH:MM:ss', ignore: 'pid,hostname' } } : undefined,
});
