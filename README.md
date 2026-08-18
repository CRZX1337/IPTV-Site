# HOODTV

Moderne, eigenständige IPTV-Webplattform. Ein **einzelner globaler Xtream-Stream**
wird durch das Backend an alle Zuschauer verteilt — die Xtream-Zugangsdaten
verlassen den Server niemals und erreichen keinen Browser.

```
Browser ──(HLS über opaque Proxy-Tokens)──▶ HOODTV Backend ──(Xtream API + /live/*)──▶ Provider
```

## Features

- **Live-Player** direkt im Browser (hls.js; iOS/Safari nutzt natives HLS)
- **Kategorien, Suche, Sender, Favoriten** (localStorage) und **EPG** (Jetzt/Danach)
- **Admin- & User-Login** mit zwei separat, kryptografisch zufällig generierten Passwörtern
- **Server-seitig erzwungene Rechte:**
  - Admin darf jederzeit starten / stoppen / wechseln
  - User darf nur wechseln, wenn **≥ 30 Minuten** keine Admin-Aktivität stattfand
  - Wenn ein User wechseln darf, ändert er den **globalen Sender für alle**
- **Ein einziger globaler Stream**: Channel-Wechsel werden über eine Mutex serialisiert;
  alte Stream-Tokens werden sofort invalidiert → keine parallelen Streams, keine Race Conditions
- **Kein Transcoding**: HLS-Playlists und Segmente werden byte-genau weitergeleitet
  (effizient für Server mit begrenzten Ressourcen)
- **SSE** synchronisiert den globalen Zustand live an alle Clients
- Mobile-first UI im Matrix/Cyber-Look (schwarz/weiß/Cyber-Grün), für iOS Safari optimiert

## Voraussetzungen

- Node.js **≥ 20** (getestet mit 22)

## Schnellstart

```bash
npm install

# .env anlegen und Xtream-Daten eintragen
cp .env.example .env
#   XTREAM_HOST=http://dein-provider.example:8080
#   XTREAM_USERNAME=...
#   XTREAM_PASSWORD=...

npm start
```

Beim **ersten Start** werden die beiden Passwörter kryptografisch zufällig erzeugt,
**einmalig** im Terminal ausgegeben und danach nur als scrypt-Hash in
`data/auth.json` gespeichert. Werte notieren!

Neue Passwörter generieren:

```bash
rm -rf data && npm start
```

Ohne konfigurierte Xtream-Daten startet der Server ebenfalls (leere Senderliste,
„NO SIGNAL“). Zum lokalen Ausprobieren gibt es einen Mock-Provider:

```bash
node scripts/mock-xtream.js 8090
XTREAM_HOST=http://127.0.0.1:8090 XTREAM_USERNAME=user XTREAM_PASSWORD=pass npm start
```

## Konfiguration (`.env`)

| Variable | Default | Bedeutung |
| --- | --- | --- |
| `XTREAM_HOST` | – | Basis-URL des Xtream-Servers (ohne Pfad/Trailing Slash) |
| `XTREAM_USERNAME` / `XTREAM_PASSWORD` | – | Xtream-Zugang (nur Backend) |
| `PORT` | `8080` | HTTP-Port |
| `SESSION_TTL_MS` | `86400000` | Session-Laufzeit |
| `USER_IDLE_MINUTES` | `30` | Sperre für User nach Admin-Aktivität |
| `CHANNEL_CACHE_MS` | `60000` | Cache für Kategorien/Sender |
| `EPG_CACHE_MS` | `30000` | Cache für EPG |
| `PROXY_TOKEN_TTL_MS` | `180000` | Idle-TTL der Stream-Proxy-Tokens |

## Sicherheitsmodell

- **Zugangsdaten bleiben serverseitig.** Der Browser erhält ausschließlich
  undurchsichtige, zufällige Proxy-Tokens (`/api/stream/:id/raw/:token`),
  niemals die Xtream-URLs, die Pfade oder die Credentials.
- **Single Stream wird erzwungen.** Nur der aktuell aktive Sender ist streambar;
  jede Anfrage an einen anderen Sender wird mit `409` abgewiesen. Wechsel sind
  durch eine Mutex serialisiert und erhöhen eine Stream-Epoche, die alle alten
  Tokens invalidiert.
- **30-Minuten-Sperre wird serverseitig geprüft** (`403 user_locked`). Der
  Zeitstempel der letzten Admin-Aktivität überlebt Server-Neustarts.
- **Login-Rate-Limiting** pro IP, Passwörter als scrypt-Hash, Sessions als
  httpOnly-Cookie, kryptografisch zufällige Tokens.

## API (Auszug)

| Methode & Pfad | Rolle | Zweck |
| --- | --- | --- |
| `POST /api/auth/login` | – | Login (`{role, password}`) |
| `POST /api/auth/logout` | – | Logout |
| `GET /api/auth/me` | – | Session + aktueller Zustand |
| `GET /api/channels` | beliebig | Kategorien + Sender (Logos proxied) |
| `GET /api/epg/:streamId` | beliebig | Kurz-EPG |
| `POST /api/control/play` | admin/user | Start/Wechsel (User nur nach Sperre) |
| `POST /api/control/stop` | admin | Stop |
| `GET /api/stream/:id/playlist.m3u8` | beliebig | HLS-Playlist des aktiven Senders |
| `GET /api/stream/:id/raw/:token` | beliebig | Proxied Segment/Playlist |
| `GET /api/media/:token` | beliebig | Proxied Senderlogos |
| `GET /api/events` | beliebig | SSE-Live-Zustand |

## Struktur

```
src/
  config.js    Konfiguration + .env-Loader
  auth.js      Passwort-Generierung, scrypt, Sessions, Rate-Limit
  store.js     JSON-Persistenz (Passwort-Hashes, letzte Admin-Aktivität)
  xtream.js    Xtream-Client (Katalog/EPG, Caching)
  stream.js    Globaler Stream-Zustand, Mutex, Proxy-Tokens, SSE
  routes.js    Express-Routen
  server.js    Einstiegspunkt
public/        Frontend (Vanilla JS + CSS, hls.js vendored)
scripts/       Mock-Xtream für lokale Tests
test/          Unit- + End-to-End-Tests
```

## Tests

```bash
npm test
```

Deckt ab: Passwort-Hashing/Sessions/Rate-Limit, 30-Minuten-Sperre,
Mutex-Serialisierung (Race Conditions), Single-Stream-Durchsetzung,
Playlist-Rewriting (keine Credential-Leaks) sowie ein End-to-End-Test gegen
einen Mock-Xtream-Server (Login → Play → Playlist → Segment, alles opaque).
