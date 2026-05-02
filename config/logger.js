/**
 * config/logger.js — WhatsBotLyn v12
 *
 * Structured logger. Zero dependencies — works out of the box.
 * Replace console.log/warn/error everywhere with this.
 *
 * Log levels (controlled by LOG_LEVEL env var):
 *   error → always shown
 *   warn  → always shown
 *   info  → default in production
 *   debug → default in development
 *
 * Output format:
 *   Development → human-readable coloured text
 *   Production  → JSON (one object per line — compatible with Datadog, Logtail, Papertrail)
 *
 * Usage:
 *   import logger from '../config/logger.js';
 *   logger.info('Webhook received', { wamid, from });
 *   logger.error('DB save failed', { err: err.message, tenantId });
 */

const isProd = process.env.NODE_ENV === 'production';
const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const DEFAULT_LEVEL = isProd ? 'info' : 'debug';
const ACTIVE_LEVEL = LEVELS[process.env.LOG_LEVEL] ?? LEVELS[DEFAULT_LEVEL];

const COLOURS = {
  error: '\x1b[31m', // red
  warn:  '\x1b[33m', // yellow
  info:  '\x1b[36m', // cyan
  debug: '\x1b[90m', // grey
  reset: '\x1b[0m',
};

function write(level, message, meta = {}) {
  if (LEVELS[level] > ACTIVE_LEVEL) return;

  if (isProd) {
    // JSON mode — one line per log entry, easy to parse/search
    const entry = {
      ts:    new Date().toISOString(),
      level,
      msg:   message,
      env:   process.env.NODE_ENV,
      ...meta,
    };
    const line = JSON.stringify(entry);
    (level === 'error' || level === 'warn')
      ? process.stderr.write(line + '\n')
      : process.stdout.write(line + '\n');
  } else {
    // Human-readable mode for development
    const ts    = new Date().toISOString().slice(11, 23); // HH:MM:SS.mmm
    const col   = COLOURS[level] || '';
    const reset = COLOURS.reset;
    const tag   = `${col}[${level.toUpperCase().padEnd(5)}]${reset}`;
    const metaStr = Object.keys(meta).length
      ? ' ' + Object.entries(meta).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(' ')
      : '';
    process.stdout.write(`${ts} ${tag} ${message}${metaStr}\n`);
  }
}

const logger = {
  error: (msg, meta) => write('error', msg, meta),
  warn:  (msg, meta) => write('warn',  msg, meta),
  info:  (msg, meta) => write('info',  msg, meta),
  debug: (msg, meta) => write('debug', msg, meta),
};

export default logger;
