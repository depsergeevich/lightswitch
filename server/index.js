'use strict';

const config = require('./src/config');
const { Store } = require('./src/store');
const { PushServer } = require('./src/push-server');
const { GldServer } = require('./src/gld-server');
const log = require('./src/log').make('main');

async function main() {
  const store = new Store();
  const push = new PushServer(config, store);
  const gld = new GldServer(config, store);

  await Promise.all([push.start(), gld.start()]);

  log.info('Lightswitch up.');
  log.info(`  REST  https://${config.bindHost}:${config.gldPort} + http://${config.bindHost}:${config.gldHttpPort}`);
  log.info(`        contact/file/sms advertised over ${config.restTls ? 'HTTPS' : 'HTTP (plaintext)'}`);
  log.info(`  Push  ${config.pushTls ? 'tls' : 'tcp'}://${config.bindHost}:${config.pushPort} ${config.pushTls ? '' : '(PLAINTEXT — needs the smali SSL-off patch)'}`);
  log.info(`  advertised host: ${config.publicHost} — set LS_PUBLIC_HOST to the IP the device can reach.`);

  // Expose a tiny operator REPL over stdin: `notify <pushRegId> <text>` to push
  // a test notification to a connected device.
  process.stdin.on('data', (line) => {
    const [cmd, id, ...rest] = String(line).trim().split(/\s+/);
    if (cmd === 'notify' && id) {
      const el = push.notify(id, { sender: 'server', type: 1, body: rest.join(' ') });
      log.info('queued notification', el.seq, 'for', id);
    }
  });

  const shutdown = () => { push.stop(); gld.stop(); process.exit(0); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => { log.err('fatal', e); process.exit(1); });
