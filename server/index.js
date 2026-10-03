'use strict';

const config = require('./src/config');
const { Store } = require('./src/store');
const { PushServer } = require('./src/push-server');
const { GldServer } = require('./src/gld-server');
const log = require('./src/log').make('main');

async function main() {
  const store = new Store(config.dbPath);
  const push = new PushServer(config, store);
  const gld = new GldServer(config, store);

  await Promise.all([push.start(), gld.start()]);

  const st = store.stats();
  log.info(`Lightswitch up. DB: ${config.dbPath} (${st.accounts} accounts, ${st.friendships} friendships, ${st.queued} queued, ${st.messages} logged messages)`);
  log.info(`  REST  https://${config.bindHost}:${config.gldPort} + http://${config.bindHost}:${config.gldHttpPort}`);
  log.info(`        contact/file/sms advertised over ${config.restTls ? 'HTTPS' : 'HTTP (plaintext)'}`);
  log.info(`  Push  ${config.pushTls ? 'tls' : 'tcp'}://${config.bindHost}:${config.pushPort} ${config.pushTls ? '' : '(PLAINTEXT — needs the smali SSL-off patch)'}`);
  log.info(`  advertised host: ${config.publicHost} — set LS_PUBLIC_HOST to the IP the device can reach.`);

  // EXPERIMENTAL outbound-chat router: resolve the recipient from any phone-number-like
  // token in app_data/session_info and relay the text to that account's device(s).
  push.router = (sess, info) => {
    const fromUid = push._uid(sess);
    const from = fromUid ? store.accounts.get(fromUid) : null;
    const tokens = `${info.app_data} ${info.session_info}`.match(/\+?\d{5,}/g) || [];
    let targeted = 0;
    for (const t of tokens) {
      const acct = store.findByNumber(t);
      if (!acct || (from && acct.uid === from.uid)) continue;
      push.notifyUid(acct.uid, {
        sender: from ? from.msisdn : info.sender,
        msg: info.msg,
        app_data: info.app_data,
        session_info: info.session_info,
      });
      targeted++;
    }
    return targeted;
  };

  // Expose a tiny operator REPL over stdin: `notify <pushRegId> <text>` to push
  // a test notification to a connected device.
  process.stdin.on('data', (line) => {
    const [cmd, id, ...rest] = String(line).trim().split(/\s+/);
    if (cmd === 'say' && id) {
      // say <number> <text> — send a message to a registered account from the server
      const acct = store.findByNumber(id);
      if (!acct) return log.warn('say: no registered account for', id);
      const r = push.notifyUid(acct.uid, { sender: 'Lightswitch', msg: rest.join(' ') });
      log.info(`say -> ${acct.name} (${acct.msisdn}): ${r.sessions} live session(s), queued #${r.el.seq}`);
    }
    if (cmd === 'history') {
      const n = Number(id) || 20;
      for (const m of store.recentMessages(n)) {
        log.info(`  #${m.id} ${new Date(m.ts).toISOString()}  ${m.sender || '?'} -> ${m.recipient_uid}: ${m.text}`);
      }
    }
    if (cmd === 'accounts') {
      for (const a of store.accounts.values()) log.info(`  ${a.uid}  ${a.msisdn}  ${a.name}`);
    }
    if (cmd === 'notify' && id) {
      const el = push.notify(id, { sender: 'server', type: 1, body: rest.join(' ') });
      log.info('queued notification', el.seq, 'for', id);
    }
  });

  const shutdown = () => { push.stop(); gld.stop(); store.close(); process.exit(0); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => { log.err('fatal', e); process.exit(1); });
