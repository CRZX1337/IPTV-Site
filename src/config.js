import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Minimal .env loader (no dependency). KEY=VALUE lines, # comments, optional quotes. */
function loadEnvFile(file) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq === -1) continue;
      const key = line.slice(0, eq).trim();
      let value = line.slice(eq + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (key && process.env[key] === undefined) {
        process.env[key] = value;
      }
    }
  } catch {
    // No .env file is fine.
  }
}

loadEnvFile(path.join(ROOT, '.env'));

function intEnv(name, fallback) {
  const v = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(v) ? v : fallback;
}

function normalizeHost(host) {
  if (!host) return null;
  let h = host.trim();
  if (h.endsWith('/')) h = h.slice(0, -1);
  return h;
}

export const ROOT_DIR = ROOT;
export const DATA_DIR = process.env.HOODTV_DATA_DIR
  ? path.resolve(process.env.HOODTV_DATA_DIR)
  : path.join(ROOT, 'data');

export const config = {
  port: intEnv('PORT', 8080),
  host: process.env.HOST || '0.0.0.0',

  xtreamHost: normalizeHost(process.env.XTREAM_HOST),
  xtreamUsername: process.env.XTREAM_USERNAME || '',
  xtreamPassword: process.env.XTREAM_PASSWORD || '',

  sessionTtlMs: intEnv('SESSION_TTL_MS', 24 * 60 * 60 * 1000),
  userIdleMinutes: intEnv('USER_IDLE_MINUTES', 30),
  channelCacheMs: intEnv('CHANNEL_CACHE_MS', 60_000),
  epgCacheMs: intEnv('EPG_CACHE_MS', 30_000),
  proxyTokenTtlMs: intEnv('PROXY_TOKEN_TTL_MS', 180_000),

  loginMaxAttempts: intEnv('LOGIN_MAX_ATTEMPTS', 8),
  loginWindowMs: intEnv('LOGIN_WINDOW_MS', 5 * 60 * 1000),
};

export const xtreamConfigured = Boolean(
  config.xtreamHost && config.xtreamUsername && config.xtreamPassword,
);

export const userIdleMs = config.userIdleMinutes * 60 * 1000;

export function xtreamOrigin() {
  if (!config.xtreamHost) return null;
  return new URL(config.xtreamHost);
}
