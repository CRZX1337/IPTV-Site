import crypto from 'node:crypto';
import { loadAuth, saveAuth } from './store.js';

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LEN = 64;

/** Cryptographically random human-friendly password (base64url, 22 chars, ~132 bits). */
export function generatePassword() {
  return crypto.randomBytes(16).toString('base64url');
}

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, KEY_LEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: 64 * 1024 * 1024,
  });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('base64url')}$${hash.toString('base64url')}`;
}

export function verifyPassword(password, stored) {
  if (typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, saltB64, hashB64] = parts;
  try {
    const salt = Buffer.from(saltB64, 'base64url');
    const expected = Buffer.from(hashB64, 'base64url');
    const actual = crypto.scryptSync(String(password), salt, expected.length, {
      N: Number(n),
      r: Number(r),
      p: Number(p),
      maxmem: 64 * 1024 * 1024,
    });
    return crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/**
 * Factory keeps the code testable (injectable clock) and the runtime state isolated.
 */
export function createAuthManager({ ttlMs, maxAttempts, windowMs, now = () => Date.now(), store } = {}) {
  const sessions = new Map(); // token -> { role, expiresAt }
  const attempts = new Map(); // ip -> { count, resetAt }
  const persistence = store || { load: loadAuth, save: saveAuth };

  // Load (or create) the two passwords on first use.
  const auth = persistence.load();
  let generatedCredentials = null;

  function ensurePasswords() {
    if (auth.admin && auth.user) return;
    const adminPw = generatePassword();
    const userPw = generatePassword();
    auth.admin = hashPassword(adminPw);
    auth.user = hashPassword(userPw);
    persistence.save(auth);
    generatedCredentials = { admin: adminPw, user: userPw };
  }
  ensurePasswords();

  function createSession(role) {
    const token = crypto.randomBytes(32).toString('base64url');
    sessions.set(token, { role, expiresAt: now() + ttlMs });
    return token;
  }

  function getSession(token) {
    if (!token) return null;
    const s = sessions.get(token);
    if (!s) return null;
    if (s.expiresAt <= now()) {
      sessions.delete(token);
      return null;
    }
    return s;
  }

  function destroySession(token) {
    if (token) sessions.delete(token);
  }

  function checkRateLimit(ip) {
    const t = now();
    const entry = attempts.get(ip);
    if (!entry || entry.resetAt <= t) return true;
    if (entry.count >= maxAttempts) return false;
    return true;
  }

  function recordAttempt(ip, success) {
    const t = now();
    const entry = attempts.get(ip);
    if (!entry || entry.resetAt <= t) {
      attempts.set(ip, { count: success ? 0 : 1, resetAt: t + windowMs });
      return;
    }
    if (success) {
      attempts.delete(ip);
    } else {
      entry.count += 1;
    }
  }

  function login(role, password, ip) {
    if (role !== 'admin' && role !== 'user') return { ok: false, reason: 'bad_role' };
    if (!checkRateLimit(ip)) return { ok: false, reason: 'rate_limited' };

    const hash = auth[role];
    const valid = verifyPassword(password, hash);
    recordAttempt(ip, valid);

    if (!valid) return { ok: false, reason: 'invalid_credentials' };
    const token = createSession(role);
    return { ok: true, role, token };
  }

  function logout(token) {
    destroySession(token);
  }

  // Cleanup expired sessions / rate-limit entries periodically.
  const timer = setInterval(() => {
    const t = now();
    for (const [k, s] of sessions) if (s.expiresAt <= t) sessions.delete(k);
    for (const [k, e] of attempts) if (e.resetAt <= t) attempts.delete(k);
  }, 60_000).unref?.();

  return {
    login,
    logout,
    getSession,
    destroySession,
    hasCredentials: () => Boolean(auth.admin && auth.user),
    consumeGeneratedCredentials: () => {
      const c = generatedCredentials;
      generatedCredentials = null;
      return c;
    },
    stop: () => clearInterval(timer),
  };
}

export { hashPassword as _hashPassword, verifyPassword as _verifyPassword };
