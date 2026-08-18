import http from 'node:http';
import { config, xtreamConfigured, userIdleMs, ROOT_DIR } from './config.js';
import { createAuthManager } from './auth.js';
import { createXtreamClient } from './xtream.js';
import { createStreamManager } from './stream.js';
import { buildApp } from './routes.js';

const auth = createAuthManager({
  ttlMs: config.sessionTtlMs,
  maxAttempts: config.loginMaxAttempts,
  windowMs: config.loginWindowMs,
});

const xtream = createXtreamClient({
  channelCacheMs: config.channelCacheMs,
  epgCacheMs: config.epgCacheMs,
});

const stream = createStreamManager({
  xtream,
  userIdleMs,
  proxyTokenTtlMs: config.proxyTokenTtlMs,
});

const app = buildApp({ auth, xtream, stream, config, sessionTtlMs: config.sessionTtlMs });
const server = http.createServer(app);

server.listen(config.port, config.host, () => {
  console.log('');
  console.log('  ═══════════════════════════════════════════════════');
  console.log('   HOODTV // secure IPTV relay');
  console.log('  ═══════════════════════════════════════════════════');
  console.log(`   URL:      http://localhost:${config.port}`);
  console.log(`   Xtream:   ${xtreamConfigured ? config.xtreamHost : 'NOT CONFIGURED (edit .env)'}`);
  console.log('  ───────────────────────────────────────────────────');

  const creds = auth.consumeGeneratedCredentials();
  if (creds) {
    console.log('   Generated credentials (shown once - store them):');
    console.log('');
    console.log(`     ADMIN  password:  ${creds.admin}`);
    console.log(`     USER   password:  ${creds.user}`);
    console.log('');
    console.log('   Passwords are stored only as scrypt hashes in');
    console.log(`   ${ROOT_DIR}/data/auth.json`);
  } else {
    console.log('   Credentials loaded from data/auth.json (hashed).');
  }
  console.log('  ═══════════════════════════════════════════════════');
  console.log('');
});

function shutdown() {
  console.log('\n[hoodtv] shutting down...');
  server.close(() => {
    auth.stop();
    stream.stopCleanup();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 3000).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
