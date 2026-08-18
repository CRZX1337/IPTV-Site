import path from 'node:path';
import { Readable } from 'node:stream';
import express from 'express';
import { ROOT_DIR } from './config.js';
import { HttpError } from './stream.js';

const SESSION_COOKIE = 'hoodtv_session';

function readSessionToken(req) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (key === SESSION_COOKIE) return value || null;
  }
  return null;
}

function setSessionCookie(res, token, ttlMs) {
  res.setHeader(
    'Set-Cookie',
    `${SESSION_COOKIE}=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${Math.max(1, Math.floor(ttlMs / 1000))}`,
  );
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`);
}

export function buildApp({ auth, xtream, stream, config, sessionTtlMs }) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '64kb' }));

  // Lightweight security headers.
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('X-Frame-Options', 'DENY');
    next();
  });

  // Attach the authenticated session (if any) to every request.
  app.use((req, res, next) => {
    const token = readSessionToken(req);
    req.session = token ? auth.getSession(token) : null;
    req.sessionToken = token;
    next();
  });

  function requireAuth(req, res, next) {
    if (!req.session) return res.status(401).json({ error: 'unauthorized' });
    next();
  }

  function requireAdmin(req, res, next) {
    if (!req.session) return res.status(401).json({ error: 'unauthorized' });
    if (req.session.role !== 'admin') return res.status(403).json({ error: 'forbidden' });
    next();
  }

  // ---- auth -----------------------------------------------------------------
  app.post('/api/auth/login', (req, res) => {
    const { role, password } = req.body || {};
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    const result = auth.login(role, password, ip);
    if (!result.ok) {
      const status = result.reason === 'rate_limited' ? 429 : 401;
      return res.status(status).json({ error: result.reason });
    }
    if (role === 'admin') stream.markAdminActivity();
    setSessionCookie(res, result.token, sessionTtlMs);
    res.json({ ok: true, role: result.role });
  });

  app.post('/api/auth/logout', (req, res) => {
    if (req.sessionToken) auth.logout(req.sessionToken);
    clearSessionCookie(res);
    res.json({ ok: true });
  });

  app.get('/api/auth/me', (req, res) => {
    res.json({
      authenticated: Boolean(req.session),
      role: req.session ? req.session.role : null,
      state: req.session ? stream.publicState() : null,
    });
  });

  // ---- catalog --------------------------------------------------------------
  app.get('/api/state', requireAuth, (req, res) => {
    res.json(stream.publicState());
  });

  app.get('/api/channels', requireAuth, async (req, res, next) => {
    try {
      const data = await xtream.getChannels();
      // Never leak upstream asset URLs to the browser: route logos through the
      // opaque media proxy so the Xtream host stays server-side only.
      const channels = (data.channels || []).map((c) => ({ ...c, logo: proxiedLogo(c.logo) }));
      res.json({ categories: data.categories, channels });
    } catch (err) {
      next(err);
    }
  });

  app.get('/api/epg/:streamId', requireAuth, async (req, res, next) => {
    try {
      const listings = await xtream.getShortEpg(req.params.streamId, 8);
      res.json({ listings });
    } catch (err) {
      next(err);
    }
  });

  // ---- control (server-side permission enforcement) --------------------------
  app.post('/api/control/play', requireAuth, async (req, res, next) => {
    try {
      const state = await stream.play(req.session.role, req.body && req.body.channelId);
      res.json({ ok: true, state });
    } catch (err) {
      next(err);
    }
  });

  app.post('/api/control/stop', requireAdmin, async (req, res, next) => {
    try {
      const state = await stream.stop(req.session.role);
      res.json({ ok: true, state });
    } catch (err) {
      next(err);
    }
  });

  function proxiedLogo(logo) {
    if (!logo) return null;
    let abs = logo;
    if (!/^https?:\/\//i.test(logo) && xtream.origin) {
      try { abs = new URL(logo, xtream.origin.toString()).toString(); } catch { return null; }
    }
    return stream.proxiedMedia(abs);
  }

  app.get('/api/media/:token', requireAuth, async (req, res, next) => {
    try {
      const upstream = await stream.getMedia(req.params.token);
      res.status(upstream.status);
      res.setHeader('Content-Type', upstream.headers.get('content-type') || 'application/octet-stream');
      const encoding = upstream.headers.get('content-encoding');
      if (encoding) res.setHeader('Content-Encoding', encoding);
      const length = upstream.headers.get('content-length');
      if (length) res.setHeader('Content-Length', length);
      res.setHeader('Cache-Control', 'public, max-age=3600');
      const body = Readable.fromWeb(upstream.body);
      res.on('close', () => { body.destroy(); upstream.body.cancel().catch(() => {}); });
      body.on('error', () => upstream.body.cancel().catch(() => {}));
      body.pipe(res);
    } catch (err) {
      next(err);
    }
  });

  // ---- single global stream proxy -------------------------------------------
  app.get('/api/stream/:channelId/playlist.m3u8', requireAuth, async (req, res, next) => {
    try {
      const result = await stream.getRootPlaylist(req.params.channelId);
      res.setHeader('Content-Type', result.contentType);
      res.setHeader('Cache-Control', 'no-store');
      res.send(result.body);
    } catch (err) {
      next(err);
    }
  });

  app.get('/api/stream/:channelId/raw/:token', requireAuth, async (req, res, next) => {
    try {
      const result = await stream.getRaw(req.params.channelId, req.params.token);
      if (result.kind === 'playlist') {
        res.setHeader('Content-Type', result.contentType);
        res.setHeader('Cache-Control', 'no-store');
        res.send(result.body);
        return;
      }
      const upstream = result.response;
      const contentType = upstream.headers.get('content-type') || 'application/octet-stream';
      res.status(upstream.status);
      res.setHeader('Content-Type', contentType);
      const encoding = upstream.headers.get('content-encoding');
      if (encoding) res.setHeader('Content-Encoding', encoding);
      const length = upstream.headers.get('content-length');
      if (length) res.setHeader('Content-Length', length);
      res.setHeader('Cache-Control', 'no-store');

      const body = Readable.fromWeb(upstream.body);
      const closed = () => {
        body.destroy();
        upstream.body.cancel().catch(() => {});
      };
      res.on('close', closed);
      body.on('error', () => upstream.body.cancel().catch(() => {}));
      body.pipe(res);
    } catch (err) {
      next(err);
    }
  });

  // ---- live state events (SSE) ----------------------------------------------
  app.get('/api/events', requireAuth, (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    res.write(`event: state\ndata: ${JSON.stringify(stream.publicState())}\n\n`);
    stream.subscribe(res);

    const heartbeat = setInterval(() => {
      try {
        res.write(': ping\n\n');
      } catch {
        clearInterval(heartbeat);
      }
    }, 20_000);

    req.on('close', () => {
      clearInterval(heartbeat);
      stream.unsubscribe(res);
    });
  });

  // ---- static frontend ------------------------------------------------------
  app.use(
    express.static(path.join(ROOT_DIR, 'public'), {
      index: 'index.html',
      setHeaders: (res, filePath) => {
        if (filePath.endsWith('index.html')) {
          res.setHeader('Cache-Control', 'no-cache');
        } else if (/vendor\/|\.(js|css|png|svg|woff2?)$/.test(filePath)) {
          res.setHeader('Cache-Control', 'public, max-age=86400');
        }
      },
    }),
  );

  // ---- error handling -------------------------------------------------------
  app.use((req, res) => {
    res.status(404).json({ error: 'not_found' });
  });

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof HttpError) {
      return res.status(err.status).json({ error: err.code, message: err.message });
    }
    if (err && err.type === 'entity.parse.failed') {
      return res.status(400).json({ error: 'bad_json' });
    }
    console.error('[hoodtv] unhandled error:', err);
    res.status(500).json({ error: 'internal_error' });
  });

  return app;
}
