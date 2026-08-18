import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

// ---- isolated env before modules load --------------------------------------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hoodtv-e2e-'));
process.env.HOODTV_DATA_DIR = tmp;

const { createAuthManager } = await import('../src/auth.js');
const { createXtreamClient } = await import('../src/xtream.js');
const { createStreamManager } = await import('../src/stream.js');
const { buildApp } = await import('../src/routes.js');
const { userIdleMs } = await import('../src/config.js');

// ---- mock Xtream upstream ---------------------------------------------------
function makeMockXtream() {
  const cats = [{ category_id: '1', category_name: 'Cyber' }];
  const streams = [
    { stream_id: 1, num: 1, name: 'Cyber One', stream_icon: '/images/1.png', category_id: '1', stream_type: 'live' },
    { stream_id: 2, num: 2, name: 'Matrix Two', stream_icon: '/images/2.png', category_id: '1', stream_type: 'live' },
  ];
  const master = (id) => `#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000000\n${id}_v.m3u8\n`;
  const media = (id) => `#EXTM3U\n#EXT-X-VERSION:3\n#EXTINF:4.0,\n${id}_00001.ts\n#EXT-X-ENDLIST\n`;
  const seg = Buffer.from([0x47, 0x40, 0x11, 0x10, 0x00, 0x01, 0x02, 0x03]);
  const logo = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00]);

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://local');
    const send = (body, type, status = 200) => {
      res.writeHead(status, { 'content-type': type });
      res.end(body);
    };

    if (url.pathname === '/player_api.php') {
      const action = url.searchParams.get('action');
      if (action === 'get_live_categories') return send(JSON.stringify(cats), 'application/json');
      if (action === 'get_live_streams') return send(JSON.stringify(streams), 'application/json');
      return send('[]', 'application/json');
    }

    const live = url.pathname.match(/^\/live\/user\/pass\/(\d+)\.m3u8$/);
    if (live) return send(master(live[1]), 'application/vnd.apple.mpegurl');
    const variant = url.pathname.match(/^\/live\/user\/pass\/(\d+)_v\.m3u8$/);
    if (variant) return send(media(variant[1]), 'application/vnd.apple.mpegurl');
    if (/^\/live\/user\/pass\/\d+_00001\.ts$/.test(url.pathname)) return send(seg, 'video/mp2t');
    if (url.pathname.startsWith('/images/')) return send(logo, 'image/png');
    send('not found', 'text/plain', 404);
  });

  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

function freshStore() {
  let data = { admin: null, user: null };
  return { load: () => data, save: (next) => { data = next; } };
}

async function listen(app) {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, port: server.address().port, base: `http://127.0.0.1:${server.address().port}` };
}

// ---- the test ----------------------------------------------------------------
test('end-to-end: proxy hides credentials, enforces single stream and user lock', async (t) => {
  const mock = await makeMockXtream();
  const mockPort = mock.address().port;

  const xtream = createXtreamClient({
    channelCacheMs: 60_000,
    epgCacheMs: 30_000,
    host: `http://127.0.0.1:${mockPort}`,
    username: 'user',
    password: 'pass',
  });
  const auth = createAuthManager({ ttlMs: 60_000, maxAttempts: 5, windowMs: 60_000, store: freshStore() });
  const stream = createStreamManager({ xtream, userIdleMs, proxyTokenTtlMs: 60_000 });
  const app = buildApp({ auth, xtream, stream, config: {}, sessionTtlMs: 60_000 });
  const host = await listen(app);

  t.after(async () => {
    host.server.close();
    mock.close();
    auth.stop();
    stream.stopCleanup();
  });

  const creds = auth.consumeGeneratedCredentials();
  assert.ok(creds.admin && creds.user);

  async function login(role, password) {
    const res = await fetch(`${host.base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ role, password }),
    });
    const setCookie = res.headers.getSetCookie()[0];
    const cookie = setCookie ? setCookie.split(';')[0] : '';
    return { status: res.status, body: await res.json(), cookie };
  }

  const admin = await login('admin', creds.admin);
  assert.equal(admin.status, 200);

  // wrong password rejected
  const bad = await login('user', 'wrong');
  assert.equal(bad.status, 401);

  const user = await login('user', creds.user);
  assert.equal(user.status, 200);

  const authed = (cookie, path, opts = {}) =>
    fetch(`${host.base}${path}`, { ...opts, headers: { cookie, ...(opts.headers || {}) } });

  // catalog hides upstream host, proxies logos
  const catalog = await (await authed(admin.cookie, '/api/channels')).json();
  assert.equal(catalog.channels.length, 2);
  assert.match(catalog.channels[0].logo, /^\/api\/media\/[A-Za-z0-9_-]+$/);
  assert.ok(!JSON.stringify(catalog).includes('127.0.0.1'));

  // admin starts channel 1
  const play = await authed(admin.cookie, '/api/control/play', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ channelId: '1' }),
  });
  assert.equal(play.status, 200);
  assert.equal((await play.json()).state.channel.id, '1');

  // user is locked immediately after admin activity
  const userPlay = await authed(user.cookie, '/api/control/play', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ channelId: '2' }),
  });
  assert.equal(userPlay.status, 403);
  assert.equal((await userPlay.json()).error, 'user_locked');

  // playlist is rewritten and credential-free
  const plRes = await authed(admin.cookie, '/api/stream/1/playlist.m3u8');
  assert.equal(plRes.status, 200);
  const pl = await plRes.text();
  assert.ok(!pl.includes('127.0.0.1'));
  assert.ok(!pl.includes('pass'));
  assert.ok(!pl.includes('user'));
  const token1 = pl.match(/\/api\/stream\/1\/raw\/([A-Za-z0-9_-]+)/)[1];

  // follow variant -> media playlist -> segment, all opaque
  const variantRes = await authed(admin.cookie, `/api/stream/1/raw/${token1}`);
  assert.equal(variantRes.status, 200);
  const media = await variantRes.text();
  assert.ok(!media.includes('127.0.0.1'));
  const token2 = media.match(/\/api\/stream\/1\/raw\/([A-Za-z0-9_-]+)/)[1];

  const segRes = await authed(admin.cookie, `/api/stream/1/raw/${token2}`);
  assert.equal(segRes.status, 200);
  assert.equal(segRes.headers.get('content-type'), 'video/mp2t');
  const segBytes = Buffer.from(await segRes.arrayBuffer());
  assert.equal(segBytes[0], 0x47);

  // non-current channel is rejected (single global stream)
  const otherRes = await authed(admin.cookie, '/api/stream/2/playlist.m3u8');
  assert.equal(otherRes.status, 409);

  // switch: old channel's token immediately invalid
  await authed(admin.cookie, '/api/control/play', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ channelId: '2' }),
  });
  const staleRes = await authed(admin.cookie, `/api/stream/1/raw/${token1}`);
  assert.equal(staleRes.status, 409);

  // stop -> playlist rejected
  const stopRes = await authed(admin.cookie, '/api/control/stop', { method: 'POST' });
  assert.equal(stopRes.status, 200);
  const afterStop = await authed(admin.cookie, '/api/stream/2/playlist.m3u8');
  assert.equal(afterStop.status, 409);

  // SSE emits an initial state frame
  const sseChunk = await new Promise((resolve, reject) => {
    const req = http.get(`${host.base}/api/events`, { headers: { cookie: admin.cookie } }, (res) => {
      res.once('data', (chunk) => { resolve(chunk.toString()); req.destroy(); });
    });
    req.on('error', reject);
  });
  assert.match(sseChunk, /^event: state\n/);
});
