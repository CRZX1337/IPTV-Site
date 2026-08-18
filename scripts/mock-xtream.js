/**
 * Standalone mock Xtream server for manual/visual testing of HOODTV without a
 * real provider. Run it, then point XTREAM_HOST at it in .env.
 *
 *   node scripts/mock-xtream.js 8090
 */
import http from 'node:http';

const port = Number(process.argv[2]) || 8090;

const categories = [
  { category_id: '1', category_name: 'Cyber News' },
  { category_id: '2', category_name: 'Matrix Movies' },
];

const streams = [
  { stream_id: 1, num: 1, name: 'HOOD ONE', stream_icon: '/images/1.png', category_id: '1', stream_type: 'live' },
  { stream_id: 2, num: 2, name: 'NIGHT CITY TV', stream_icon: '/images/2.png', category_id: '1', stream_type: 'live' },
  { stream_id: 3, num: 3, name: 'ZION SPORT', stream_icon: '/images/3.png', category_id: '2', stream_type: 'live' },
  { stream_id: 4, num: 4, name: 'GRID DOCS', stream_icon: '/images/4.png', category_id: '2', stream_type: 'live' },
  { stream_id: 5, num: 5, name: 'NEBULA 24', stream_icon: '/images/5.png', category_id: '2', stream_type: 'live' },
];

const master = (id) => [
  '#EXTM3U',
  '#EXT-X-VERSION:3',
  `#EXT-X-STREAM-INF:BANDWIDTH=1200000,RESOLUTION=1280x720`,
  `${id}_v.m3u8`,
  '',
].join('\n');

// A looping playlist of tiny fake TS segments (test pattern content).
const media = (id) => {
  const lines = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:4', '#EXT-X-MEDIA-SEQUENCE:0'];
  for (let i = 0; i < 5; i++) {
    lines.push('#EXTINF:4.0,');
    lines.push(`${id}_${String(i).padStart(5, '0')}.ts`);
  }
  lines.push('#EXT-X-ENDLIST');
  return lines.join('\n') + '\n';
};

const seg = Buffer.alloc(188 * 10);
for (let i = 0; i < seg.length; i++) seg[i] = (i * 31 + 7) & 0xff;
seg[0] = 0x47;

const logoPng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://local');
  const send = (body, type, status = 200) => {
    res.writeHead(status, { 'content-type': type });
    res.end(body);
  };

  if (url.pathname === '/player_api.php') {
    const action = url.searchParams.get('action');
    if (action === 'get_live_categories') return send(JSON.stringify(categories), 'application/json');
    if (action === 'get_live_streams') return send(JSON.stringify(streams), 'application/json');
    if (action === 'get_short_epg') {
      const now = Math.floor(Date.now() / 1000);
      return send(
        JSON.stringify({
          epg_listings: [
            { id: 'e1', title: 'Cyber News Live', description: 'Current show', start: now - 300, end: now + 600, start_timestamp: now - 300, stop_timestamp: now + 600 },
            { id: 'e2', title: 'Night Drive', description: 'Up next', start: now + 600, end: now + 1200, start_timestamp: now + 600, stop_timestamp: now + 1200 },
          ],
        }),
        'application/json',
      );
    }
    return send('[]', 'application/json');
  }

  const live = url.pathname.match(/^\/live\/user\/pass\/(\d+)\.m3u8$/);
  if (live) return send(master(live[1]), 'application/vnd.apple.mpegurl');
  const variant = url.pathname.match(/^\/live\/user\/pass\/(\d+)_v\.m3u8$/);
  if (variant) return send(media(variant[1]), 'application/vnd.apple.mpegurl');
  if (/^\/live\/user\/pass\/\d+_\d{5}\.ts$/.test(url.pathname)) return send(seg, 'video/mp2t');
  if (url.pathname.startsWith('/images/')) return send(logoPng, 'image/png');
  send('not found', 'text/plain', 404);
});

server.listen(port, '127.0.0.1', () => {
  console.log(`Mock Xtream running at http://127.0.0.1:${port}`);
  console.log(`Set XTREAM_HOST=http://127.0.0.1:${port} XTREAM_USERNAME=user XTREAM_PASSWORD=pass`);
});
