import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';

/**
 * Small JSON file store. Keeps things that must survive restarts:
 *  - the two password hashes (never the plaintext)
 *  - the timestamp of the last admin activity (so the 30min user lock survives restarts)
 */

const AUTH_FILE = path.join(DATA_DIR, 'auth.json');
const STATE_FILE = path.join(DATA_DIR, 'state.json');

function ensureDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(file, data) {
  ensureDir();
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

export function loadAuth() {
  return readJson(AUTH_FILE, { admin: null, user: null });
}

export function saveAuth(auth) {
  writeJsonAtomic(AUTH_FILE, auth);
}

export function loadState() {
  return readJson(STATE_FILE, { lastAdminAt: 0 });
}

export function saveState(state) {
  writeJsonAtomic(STATE_FILE, state);
}
