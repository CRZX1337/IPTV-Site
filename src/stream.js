import crypto from 'node:crypto';
import { loadState, saveState } from './store.js';

export class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const PLAYLIST_RE = /#EXTM3U/i;

function looksLikePlaylist(contentType, url) {
  if (/mpegurl|m3u8|m3u|vnd\.apple/i.test(contentType || '')) return true;
  if (/\.m3u8?($|[?#])/i.test(url || '')) return true;
  return false;
}

/**
 * Global, single-stream state machine.
 *
 * There is exactly ONE active channel for the whole platform. Every viewer
 * streams that same channel through the backend proxy. Channel switches are
 * serialized with a mutex so concurrent requests can never produce two
 * parallel streams or interleave state updates.
 */
export function createStreamManager({
  xtream,
  userIdleMs,
  proxyTokenTtlMs,
  now = () => Date.now(),
  fetchImpl = fetch,
  randomBytes = crypto.randomBytes,
} = {}) {
  const state = loadState();
  let lastAdminAt = Number.isFinite(state.lastAdminAt) ? state.lastAdminAt : 0;

  let current = { channelId: null, channel: null, version: 0, startedAt: 0 };
  let streamEpoch = 0; // bumped on every play/stop; invalidates old proxy tokens

  const proxyTokens = new Map(); // token -> { url, channelId, expiresAt }
  const mediaTokens = new Map(); // token -> { url, expiresAt } (logos etc.)
  const subscribers = new Set(); // response objects for SSE

  // ---- mutex (promise-chain serialization) ---------------------------------
  let tail = Promise.resolve();
  function serialize(fn) {
    const run = tail.then(fn, fn);
    tail = run.then(
      () => {},
      () => {},
    );
    return run;
  }

  // ---- admin activity -------------------------------------------------------
  function persistAdminAt() {
    try {
      saveState({ lastAdminAt });
    } catch {
      /* non-fatal */
    }
  }

  function markAdminActivity() {
    lastAdminAt = now();
    persistAdminAt();
    broadcast();
  }

  // ---- public state ---------------------------------------------------------
  function publicState() {
    const t = now();
    const idle = Math.max(0, t - lastAdminAt);
    const userCanSwitch = idle >= userIdleMs;
    return {
      version: current.version,
      playing: current.channelId != null,
      // Note: logo is intentionally omitted here; the catalog endpoint serves
      // logos through the opaque media proxy so upstream paths never reach the
      // browser. Clients resolve the logo from /api/channels by id.
      channel: current.channel
        ? {
            id: current.channel.id,
            name: current.channel.name,
            num: current.channel.num,
            categoryId: current.channel.categoryId,
            categoryName: current.channel.categoryName,
            epgChannelId: current.channel.epgChannelId,
          }
        : null,
      startedAt: current.startedAt,
      lastAdminAt,
      userCanSwitch,
      userSwitchInMs: userCanSwitch ? 0 : userIdleMs - idle,
      idleMinutes: Math.floor(idle / 60000),
    };
  }

  function isCurrentChannel(channelId) {
    return current.channelId != null && current.channelId === String(channelId);
  }

  // ---- control --------------------------------------------------------------
  async function findChannel(channelId) {
    const { channels } = await xtream.getChannels();
    const found = channels.find((c) => c.id === String(channelId));
    if (!found) throw new HttpError(404, 'channel_not_found', `Channel ${channelId} not found`);
    return found;
  }

  /** Start or switch the global channel. Admin always; user only after 30min idle. */
  function play(role, channelId) {
    return serialize(async () => {
      if (!channelId) throw new HttpError(400, 'bad_request', 'channelId required');
      const channel = await findChannel(channelId);
      const t = now();

      if (role === 'admin') {
        lastAdminAt = t;
        persistAdminAt();
      } else if (t - lastAdminAt < userIdleMs) {
        throw new HttpError(
          403,
          'user_locked',
          `User channel control is locked until ${userIdleMs - (t - lastAdminAt)}ms after the last admin activity`,
        );
      }

      streamEpoch += 1;
      current = {
        channelId: channel.id,
        channel,
        version: current.version + 1,
        startedAt: t,
      };
      purgeStaleTokens();
      broadcast();
      return publicState();
    });
  }

  /** Stop the global stream. Admin only. */
  function stop(role) {
    return serialize(() => {
      if (role !== 'admin') throw new HttpError(403, 'forbidden', 'Only admins may stop the stream');
      lastAdminAt = now();
      persistAdminAt();
      streamEpoch += 1;
      current = { channelId: null, channel: null, version: current.version + 1, startedAt: 0 };
      purgeStaleTokens();
      broadcast();
      return publicState();
    });
  }

  // ---- media proxy (logos etc., no channel binding) -------------------------
  function proxiedMedia(url) {
    if (!url || !/^https?:\/\//i.test(url)) return null;
    const token = randomBytes(20).toString('base64url');
    mediaTokens.set(token, { url, expiresAt: now() + proxyTokenTtlMs });
    return `/api/media/${token}`;
  }

  async function getMedia(token) {
    const entry = mediaTokens.get(token);
    if (!entry) throw new HttpError(410, 'token_gone', 'Media token is no longer valid');
    if (entry.expiresAt <= now()) {
      mediaTokens.delete(token);
      throw new HttpError(410, 'token_expired', 'Media token expired');
    }
    const res = await fetchUpstream(entry.url);
    if (!res.ok) throw new HttpError(502, 'upstream_error', `Upstream media request failed (HTTP ${res.status})`);
    return res;
  }

  // ---- proxy tokens ---------------------------------------------------------
  function createToken(url, channelId) {
    const token = randomBytes(24).toString('base64url');
    proxyTokens.set(token, {
      url,
      channelId: String(channelId),
      epoch: streamEpoch,
      expiresAt: now() + proxyTokenTtlMs,
    });
    return token;
  }

  function purgeStaleTokens() {
    for (const [k, e] of proxyTokens) {
      if (e.epoch !== streamEpoch) proxyTokens.delete(k);
    }
  }

  function proxyUri(uri, baseUrl, channelId) {
    let abs;
    try {
      abs = new URL(uri, baseUrl);
    } catch {
      return uri;
    }
    if (abs.protocol !== 'http:' && abs.protocol !== 'https:') return uri;
    const token = createToken(abs.toString(), channelId);
    return `/api/stream/${channelId}/raw/${token}`;
  }

  /** Rewrite every URI in an m3u8 so the browser only ever sees opaque proxy tokens. */
  function rewritePlaylist(text, baseUrl, channelId) {
    const out = [];
    for (const rawLine of text.split('\n')) {
      const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
      const trimmed = line.trim();
      if (!trimmed) {
        out.push(line);
        continue;
      }
      if (trimmed.startsWith('#')) {
        // EXT-X-KEY / EXT-X-MAP / EXT-X-MEDIA / EXT-X-SESSION-DATA URI attributes
        out.push(line.replace(/URI="([^"]+)"/gi, (m, uri) => `URI="${proxyUri(uri, baseUrl, channelId)}"`));
      } else {
        out.push(proxyUri(trimmed, baseUrl, channelId));
      }
    }
    return out.join('\n');
  }

  async function fetchUpstream(url) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15_000);
    let res;
    try {
      res = await fetchImpl(url, {
        signal: ctrl.signal,
        redirect: 'follow',
        headers: { 'user-agent': 'HOODTV/1.0', accept: '*/*' },
      });
    } finally {
      clearTimeout(timer);
    }
    return res;
  }

  function assertCurrentChannel(channelId) {
    if (!isCurrentChannel(channelId)) {
      throw new HttpError(409, 'stream_stale', 'This channel is no longer the active stream');
    }
  }

  /** Root master playlist for the active channel, fully rewritten. */
  async function getRootPlaylist(channelId) {
    assertCurrentChannel(channelId);
    const url = xtream.streamPlaylistUrl(channelId);
    const res = await fetchUpstream(url);
    if (!res.ok) {
      throw new HttpError(502, 'upstream_error', `Upstream playlist request failed (HTTP ${res.status})`);
    }
    const text = await res.text();
    const body = rewritePlaylist(text, url, channelId);
    return { kind: 'playlist', body, contentType: 'application/vnd.apple.mpegurl' };
  }

  /** Proxy a token-addressed upstream resource (nested playlist or segment). */
  async function getRaw(channelId, token) {
    assertCurrentChannel(channelId);
    const entry = proxyTokens.get(token);
    if (!entry) throw new HttpError(410, 'token_gone', 'Stream token is no longer valid');
    if (entry.epoch !== streamEpoch) {
      proxyTokens.delete(token);
      throw new HttpError(409, 'stream_stale', 'This channel is no longer the active stream');
    }
    if (entry.channelId !== String(channelId)) {
      throw new HttpError(409, 'stream_stale', 'This channel is no longer the active stream');
    }
    if (entry.expiresAt <= now()) {
      proxyTokens.delete(token);
      throw new HttpError(410, 'token_expired', 'Stream token expired');
    }
    // Sliding expiry: playlist tokens are re-requested continuously by the
    // player, so they stay alive for the whole stream; one-shot segments age out.
    entry.expiresAt = now() + proxyTokenTtlMs;

    const res = await fetchUpstream(entry.url);
    if (!res.ok) {
      throw new HttpError(502, 'upstream_error', `Upstream request failed (HTTP ${res.status})`);
    }

    if (looksLikePlaylist(res.headers.get('content-type'), entry.url)) {
      const text = await res.text();
      return {
        kind: 'playlist',
        body: rewritePlaylist(text, entry.url, channelId),
        contentType: 'application/vnd.apple.mpegurl',
      };
    }
    return { kind: 'stream', response: res };
  }

  // ---- SSE ------------------------------------------------------------------
  function subscribe(res) {
    subscribers.add(res);
    res.on('close', () => subscribers.delete(res));
  }

  function unsubscribe(res) {
    subscribers.delete(res);
  }

  function broadcast() {
    const payload = `event: state\ndata: ${JSON.stringify(publicState())}\n\n`;
    for (const res of subscribers) {
      try {
        res.write(payload);
      } catch {
        subscribers.delete(res);
      }
    }
  }

  // ---- token cleanup --------------------------------------------------------
  const cleanupTimer = setInterval(() => {
    const t = now();
    for (const [k, e] of proxyTokens) if (e.expiresAt <= t) proxyTokens.delete(k);
    for (const [k, e] of mediaTokens) if (e.expiresAt <= t) mediaTokens.delete(k);
  }, 60_000).unref?.();

  return {
    play,
    stop,
    markAdminActivity,
    publicState,
    isCurrentChannel,
    getRootPlaylist,
    getRaw,
    proxiedMedia,
    getMedia,
    subscribe,
    unsubscribe,
    broadcast,
    _rewritePlaylist: rewritePlaylist,
    _playlistRegex: PLAYLIST_RE,
    stopCleanup: () => clearInterval(cleanupTimer),
  };
}
