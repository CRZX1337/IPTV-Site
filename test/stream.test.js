import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hoodtv-stream-'));
process.env.HOODTV_DATA_DIR = tmp;

const { createStreamManager, HttpError } = await import('../src/stream.js');

const CHANNELS = [
  { id: '100', name: 'Cyber One', logo: 'http://x/img/1.png', num: 1, categoryId: '1', categoryName: 'News', epgChannelId: '' },
  { id: '200', name: 'Matrix Two', logo: 'http://x/img/2.png', num: 2, categoryId: '1', categoryName: 'News', epgChannelId: '' },
];

function makeFakeXtream({ delay = 0 } = {}) {
  return {
    getChannels: async () => {
      if (delay) await new Promise((r) => setTimeout(r, delay));
      return { categories: [{ id: '1', name: 'News' }], channels: CHANNELS };
    },
    streamPlaylistUrl: (id) => `http://xtream.example/live/user/pass/${id}.m3u8`,
  };
}

function textResponse(body, contentType = 'application/vnd.apple.mpegurl') {
  return new Response(body, { status: 200, headers: { 'content-type': contentType } });
}

function makeManager({ clock, delay, fetchImpl } = {}) {
  const t = { now: 1_000_000 };
  const manager = createStreamManager({
    xtream: makeFakeXtream({ delay }),
    userIdleMs: 30 * 60 * 1000,
    proxyTokenTtlMs: 60_000,
    now: () => (clock ? clock.now : t.now),
    fetchImpl: fetchImpl || (async () => textResponse('#EXTM3U\n')),
  });
  return { manager, t };
}

test('admin can start/switch/stop; user is locked right after admin activity', async () => {
  const { manager } = makeManager();

  const start = await manager.play('admin', '100');
  assert.equal(start.playing, true);
  assert.equal(start.channel.id, '100');
  assert.equal(manager.isCurrentChannel('100'), true);

  // User is locked because admin just acted.
  await assert.rejects(() => manager.play('user', '200'), (e) => e.status === 403 && e.code === 'user_locked');

  // User cannot stop.
  await assert.rejects(() => manager.stop('user'), (e) => e.status === 403);

  const stop = await manager.stop('admin');
  assert.equal(stop.playing, false);
  assert.equal(manager.isCurrentChannel('100'), false);
});

test('user can switch only after the idle window elapses', async () => {
  const clock = { now: 1_000_000 };
  const { manager } = makeManager({ clock });

  await manager.play('admin', '100');
  // Advance 30 minutes exactly.
  clock.now += 30 * 60 * 1000;
  const play = await manager.play('user', '200');
  assert.equal(play.channel.id, '200');
  // Global channel changed for everyone.
  assert.equal(manager.isCurrentChannel('200'), true);
});

test('concurrent switches serialize without producing parallel streams', async () => {
  const clock = { now: 1_000_000 };
  // Small delay in channel resolution forces interleaving.
  const { manager } = makeManager({ clock, delay: 5 });

  await manager.play('admin', '100');
  clock.now += 30 * 60 * 1000; // unlock users

  const results = await Promise.allSettled([
    manager.play('user', '100'),
    manager.play('user', '200'),
    manager.play('user', '100'),
    manager.play('user', '200'),
  ]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 4);

  const state = manager.publicState();
  assert.ok(['100', '200'].includes(state.channel.id));
  // Only the final winner is streamable; the other channel is rejected.
  const other = state.channel.id === '100' ? '200' : '100';
  await assert.rejects(() => manager.getRootPlaylist(other), (e) => e.status === 409);
});

test('playlist proxy never leaks credentials and only the current channel streams', async () => {
  const { manager } = makeManager({
    fetchImpl: async (url) => {
      if (url.includes('100.m3u8')) {
        return textResponse(
          '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000000\n100.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=500000\n100_hi.m3u8\n',
        );
      }
      return textResponse('#EXTM3U\n');
    },
  });

  await manager.play('admin', '100');
  const { body } = await manager.getRootPlaylist('100');
  assert.ok(!body.includes('xtream.example'));
  assert.ok(!body.includes('user/pass'));
  assert.match(body, /\/api\/stream\/100\/raw\/[A-Za-z0-9_-]+/);
  // Two variant lines produced two proxy URLs.
  assert.equal(body.split('/raw/').length - 1, 2);

  const token = body.match(/\/api\/stream\/100\/raw\/([A-Za-z0-9_-]+)/)[1];
  assert.ok(token);

  // Segments stream through the opaque token.
  const seg = await manager.getRaw('100', token);
  assert.equal(seg.kind, 'playlist');

  // After switching, the old channel's tokens are rejected (no parallel streams).
  await manager.play('admin', '200');
  await assert.rejects(() => manager.getRaw('100', token), (e) => e.status === 409);
});

test('rewritePlaylist handles segment lines and EXT-X-KEY URI attributes', () => {
  const { manager } = makeManager();
  const input = [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    '#EXT-X-KEY:METHOD=AES-128,URI="key.php?k=abc",IV=0x0001',
    '#EXTINF:4.0,',
    'seg_001.ts',
    '#EXT-X-ENDLIST',
  ].join('\n');
  const out = manager._rewritePlaylist(input, 'http://xtream.example/live/user/pass/100.m3u8', '100');
  assert.ok(!out.includes('xtream.example'));
  assert.ok(!out.includes('user/pass'));
  assert.match(out, /URI="\/api\/stream\/100\/raw\/[A-Za-z0-9_-]+"/);
  assert.match(out, /^\/api\/stream\/100\/raw\/[A-Za-z0-9_-]+$/m);
});

test('media proxy creates opaque tokens and rejects unknown tokens', async () => {
  const { manager } = makeManager({
    fetchImpl: async () => new Response(Buffer.from([1, 2, 3]), {
      status: 200,
      headers: { 'content-type': 'image/png' },
    }),
  });
  const url = manager.proxiedMedia('http://xtream.example/images/logo.png');
  assert.match(url, /^\/api\/media\/[A-Za-z0-9_-]+$/);
  const token = url.split('/').pop();
  const res = await manager.getMedia(token);
  assert.equal(res.headers.get('content-type'), 'image/png');
  await assert.rejects(() => manager.getMedia('bogus'), (e) => e.status === 410);
});
