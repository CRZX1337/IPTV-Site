import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

// Isolate persistence before the config module is loaded.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hoodtv-auth-'));
process.env.HOODTV_DATA_DIR = tmp;

const authMod = await import('../src/auth.js');

function freshStore() {
  let data = { admin: null, user: null };
  return { load: () => data, save: (next) => { data = next; } };
}

test('generated passwords are random and long enough', () => {
  const a = authMod.generatePassword();
  const b = authMod.generatePassword();
  assert.ok(a !== b);
  assert.ok(a.length >= 20);
  assert.match(a, /^[A-Za-z0-9_-]+$/);
});

test('password hashing verifies correctly and rejects wrong passwords', () => {
  const hash = authMod.hashPassword('s3cret-pw');
  assert.ok(authMod.verifyPassword('s3cret-pw', hash));
  assert.ok(!authMod.verifyPassword('wrong', hash));
  assert.ok(!authMod.verifyPassword('s3cret-pw', 'garbage'));
});

test('login creates sessions and enforces roles', () => {
  const auth = authMod.createAuthManager({ ttlMs: 60_000, maxAttempts: 5, windowMs: 60_000, store: freshStore() });
  const creds = auth.consumeGeneratedCredentials();
  assert.ok(creds && creds.admin && creds.user && creds.admin !== creds.user);

  const ok = auth.login('admin', creds.admin, '1.2.3.4');
  assert.equal(ok.ok, true);
  assert.equal(ok.role, 'admin');
  assert.ok(auth.getSession(ok.token));

  const bad = auth.login('user', 'nope', '1.2.3.4');
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, 'invalid_credentials');

  const user = auth.login('user', creds.user, '5.6.7.8');
  assert.equal(user.ok, true);
  assert.equal(user.role, 'user');

  auth.stop();
});

test('login is rate limited per IP', () => {
  const auth = authMod.createAuthManager({ ttlMs: 60_000, maxAttempts: 3, windowMs: 60_000, store: freshStore() });
  for (let i = 0; i < 3; i++) {
    assert.equal(auth.login('admin', 'wrong', '9.9.9.9').ok, false);
  }
  const limited = auth.login('admin', 'whatever', '9.9.9.9');
  assert.equal(limited.ok, false);
  assert.equal(limited.reason, 'rate_limited');
  auth.stop();
});

test('sessions expire', () => {
  let t = 0;
  const auth = authMod.createAuthManager({
    ttlMs: 10_000,
    maxAttempts: 5,
    windowMs: 60_000,
    now: () => t,
    store: freshStore(),
  });
  const creds = auth.consumeGeneratedCredentials();
  const ok = auth.login('admin', creds.admin, '1.1.1.1');
  assert.ok(auth.getSession(ok.token));
  t = 11_000;
  assert.equal(auth.getSession(ok.token), null);
  auth.stop();
});
