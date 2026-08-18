import { config, xtreamOrigin } from './config.js';

const FETCH_TIMEOUT_MS = 12_000;

/**
 * Xtream API client. Credentials live ONLY here on the server.
 * The browser never sees the Xtream host, username or password.
 *
 * `host`/`username`/`password` may be overridden (used by tests); otherwise
 * they come from configuration.
 */
export function createXtreamClient({ channelCacheMs, epgCacheMs, now = () => Date.now(), fetchImpl = fetch, host, username, password } = {}) {
  const HOST = host || config.xtreamHost;
  const USER = username ?? config.xtreamUsername;
  const PASS = password ?? config.xtreamPassword;
  const configured = Boolean(HOST && USER && PASS);

  let categoriesCache = { data: null, at: 0, inflight: null };
  let streamsCache = { data: null, at: 0, inflight: null };
  const epgCache = new Map(); // streamId -> { data, at, inflight }

  function playerApi(action) {
    const u = new URL(`${HOST}/player_api.php`);
    u.searchParams.set('username', USER);
    u.searchParams.set('password', PASS);
    u.searchParams.set('action', action);
    return u.toString();
  }

  async function fetchJson(url) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetchImpl(url, { signal: ctrl.signal, headers: { accept: 'application/json' } });
      if (!res.ok) {
        throw new Error(`Xtream request failed: HTTP ${res.status}`);
      }
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  function singleFlight(holder, ttlMs, loader) {
    if (holder.data && now() - holder.at < ttlMs) return holder.data;
    if (holder.inflight) return holder.inflight;
    holder.inflight = loader()
      .then((data) => {
        holder.data = data;
        holder.at = now();
        return data;
      })
      .finally(() => {
        holder.inflight = null;
      });
    return holder.inflight;
  }

  async function getLiveCategories() {
    if (!configured) return [];
    return singleFlight(
      categoriesCache,
      channelCacheMs,
      async () => (await fetchJson(playerApi('get_live_categories'))) || [],
    );
  }

  async function getLiveStreams() {
    if (!configured) return [];
    return singleFlight(
      streamsCache,
      channelCacheMs,
      async () => (await fetchJson(playerApi('get_live_streams'))) || [],
    );
  }

  /** Combined, denormalized channel list: categories + channels with category names. */
  async function getChannels() {
    if (!configured) return { categories: [], channels: [] };
    const [categories, streams] = await Promise.all([getLiveCategories(), getLiveStreams()]);
    const catName = new Map();
    for (const c of categories) {
      if (c && c.category_id != null) catName.set(String(c.category_id), c.category_name);
    }
    const channels = (Array.isArray(streams) ? streams : [])
      .filter((s) => s && s.stream_id != null && (s.stream_type === 'live' || s.stream_type == null))
      .map((s) => ({
        id: String(s.stream_id),
        num: s.num,
        name: s.name || `Channel ${s.stream_id}`,
        logo: s.stream_icon || '',
        categoryId: s.category_id != null ? String(s.category_id) : '',
        categoryName: catName.get(String(s.category_id)) || 'Uncategorized',
        epgChannelId: s.epg_channel_id || '',
      }));
    const ordered = categories
      .filter((c) => c && c.category_id != null)
      .map((c) => ({ id: String(c.category_id), name: c.category_name }));
    return { categories: ordered, channels };
  }

  /** Direct live HLS playlist URL for a stream id (server-side only). */
  function streamPlaylistUrl(streamId) {
    return `${HOST}/live/${encodeURIComponent(USER)}/${encodeURIComponent(PASS)}/${encodeURIComponent(streamId)}.m3u8`;
  }

  async function getShortEpg(streamId, limit = 6) {
    if (!configured) return [];
    const key = String(streamId);
    const holder = epgCache.get(key) || { data: null, at: 0, inflight: null };
    epgCache.set(key, holder);
    return singleFlight(holder, epgCacheMs, async () => {
      const url = `${playerApi('get_short_epg')}&stream_id=${encodeURIComponent(streamId)}&limit=${encodeURIComponent(limit)}`;
      const data = await fetchJson(url);
      return (data && Array.isArray(data.epg_listings) ? data.epg_listings : []).map((e) => ({
        id: e.id,
        title: e.title || '',
        description: e.description || '',
        start: e.start ? Number(e.start) : null,
        end: e.end ? Number(e.end) : null,
        startTimestamp: e.start_timestamp ? Number(e.start_timestamp) : null,
        stopTimestamp: e.stop_timestamp ? Number(e.stop_timestamp) : null,
      }));
    });
  }

  return {
    configured,
    origin: HOST ? new URL(HOST) : xtreamOrigin(),
    getChannels,
    getShortEpg,
    streamPlaylistUrl,
  };
}
