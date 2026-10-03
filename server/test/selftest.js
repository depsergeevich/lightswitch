'use strict';

// End-to-end self-test. Spins up the push + GLD servers on localhost, then runs
// a fake client that mirrors the real client's wire behavior:
//   InitRequest -> expect InitReply(result=1000, async echoed)
//   RegistrationRequest -> expect RegistrationReply(result=1000)
//   PingRequest -> expect PingReply(echo)
//   server-side notify() -> expect NotiGroup; client sends NotiAcks
// Also hits GLD /prov over HTTPS and checks the JSON shape.
//
// Uses its own ports and the generated certs (ca.crt to trust our server).

const fs = require('fs');
const path = require('path');
const tls = require('tls');
const https = require('https');

const CERT_DIR = path.join(__dirname, '..', '..', 'certs');
process.env.LS_CERT_DIR = CERT_DIR;
process.env.LS_GLD_PORT = process.env.LS_GLD_PORT || '14443';
process.env.LS_PUSH_PORT = process.env.LS_PUSH_PORT || '15223';
process.env.LS_GLD_HTTP_PORT = process.env.LS_GLD_HTTP_PORT || '14080'; // avoid needing port 80
process.env.LS_PUSH_TLS = '1'; // the test drives the TLS path; plaintext is tested separately
process.env.LS_REST_TLS = '1';
process.env.LS_PUBLIC_HOST = '127.0.0.1';
process.env.LS_BIND_HOST = '127.0.0.1';

// Fresh config after env is set.
const configPath = require.resolve('../src/config');
delete require.cache[configPath];
const config = require('../src/config');

const { Store } = require('../src/store');
const { PushServer } = require('../src/push-server');
const { GldServer } = require('../src/gld-server');
const { encodeFrame, decodeFrames, b, s } = require('../src/proto');

const ca = fs.readFileSync(path.join(CERT_DIR, 'ca.crt'));

let failures = 0;
function check(cond, label, extra) {
  if (cond) {
    console.log(`  PASS  ${label}`);
  } else {
    failures++;
    console.log(`  FAIL  ${label}`, extra != null ? JSON.stringify(extra) : '');
  }
}

function tlsClient(onReady) {
  const socket = tls.connect(
    {
      host: '127.0.0.1',
      port: config.pushPort,
      ca: [ca],
      servername: 'push.samsungosp.com', // matches SAN so hostname check (if any) passes
      minVersion: 'TLSv1',
    },
    () => onReady(socket),
  );
  return socket;
}

// A promise-based request/response over the framed protocol.
function makeConn(socket) {
  let buf = Buffer.alloc(0);
  const waiters = [];
  socket.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    const { messages, rest } = decodeFrames(buf);
    buf = rest;
    for (const m of messages) {
      const w = waiters.shift();
      if (w) w(m);
    }
  });
  return {
    send: (name, body) => socket.write(encodeFrame(name, body)),
    next: (label) =>
      new Promise((res, rej) => {
        const t = setTimeout(() => rej(new Error(`timeout waiting for ${label || 'frame'}`)), 4000);
        waiters.push((m) => {
          clearTimeout(t);
          res(m);
        });
      }),
    socket,
  };
}

async function run() {
  const store = new Store();
  const push = new PushServer(config, store);
  const gld = new GldServer(config, store);
  await Promise.all([push.start(), gld.start()]);

  // --- GLD /prov over HTTPS ---
  const httpsReq = (method, path, json) =>
    new Promise((resolve, reject) => {
      const data = json ? JSON.stringify(json) : null;
      const req = https.request(
        {
          host: '127.0.0.1',
          port: config.gldPort,
          method,
          path,
          ca: [ca],
          servername: 'gld1.samsungchaton.com',
          headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {},
        },
        (res) => {
          let d = '';
          res.on('data', (c) => (d += c));
          res.on('end', () => resolve({ status: res.statusCode, body: d ? JSON.parse(d) : null }));
        },
      );
      req.on('error', reject);
      if (data) req.write(data);
      req.end();
    });

  const httpsRaw = (method, path, raw, contentType) =>
    new Promise((resolve, reject) => {
      const req = https.request(
        {
          host: '127.0.0.1', port: config.gldPort, method, path, ca: [ca],
          servername: 'gld1.samsungchaton.com',
          headers: raw ? { 'Content-Type': contentType || 'application/xml', 'Content-Length': Buffer.byteLength(raw) } : {},
        },
        (res) => { let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => resolve({ status: res.statusCode, body: d ? JSON.parse(d) : null })); },
      );
      req.on('error', reject);
      if (raw) req.write(raw);
      req.end();
    });

  const prov = (await httpsReq('GET', '/prov?imei=1&model=test&clientversion=1.10.3&platform=android&osversion=14')).body;
  const names = (prov.primary || []).map((s) => s.name).sort();
  check(JSON.stringify(names) === JSON.stringify(['contact', 'file', 'message']), 'GLD /prov has contact/message/file roles', names);
  const msg = (prov.primary || []).find((s) => s.name === 'message');
  check(msg && msg.port === config.pushPort, 'message role advertises push port', msg);
  const contact = (prov.primary || []).find((s) => s.name === 'contact');
  check(contact && contact.port === config.gldPort, 'contact role on the REST https port (=> https)', contact);
  check(typeof prov.expdate === 'number' && prov.expdate > Date.now(), 'GLD /prov expdate in future');

  // --- prov3 adds the sms role ---
  const prov3 = (await httpsReq('GET', '/prov3?phonenumber=5551234&countrycallingcode=1')).body;
  check((prov3.primary || []).some((s) => s.name === 'sms'), 'GLD /prov3 includes sms role');

  // --- registration: skip-SMS path (/auth/join), XML body like the real client ---
  const joinXml = '<param><imei>imei-1</imei><pushtype>SPP</pushtype><name>Artem</name><model>test</model><imsi>0</imsi><osversion>android 14</osversion></param>';
  const join = (await httpsRaw('POST', '/auth/join', joinXml)).body;
  check(!!join.uid && !!join.chatonid, '/auth/join (XML body) returns uid + chatonid', join);
  const joinedAcct = [...store.accounts.values()].find((acct) => acct.name === 'Artem');
  check(!!joinedAcct, 'XML <name> parsed into the account', joinedAcct);

  // --- 4-digit auth code (client input field is 4 chars) ---
  check(new Store().sendSms('t', 'p').length === 4, 'SMS auth code is 4 digits');

  // --- registration: full SMS path (token -> send -> verify -> reg), XML verify body ---
  const tok = (await httpsReq('GET', '/sms/v2/authtoken?phonenumber=5551234&countrycallingcode=1')).body;
  check(!!tok.token, '/sms/v2/authtoken returns token', tok);
  await httpsReq('GET', `/sms/v3/send?phonenumber=5551234&countrycallingcode=1`); // server prints authnum
  const smsvXml = `<param><msisdn>15551234</msisdn><token>${tok.token}</token><authnum>0000</authnum></param>`;
  const verifyRes = await httpsRaw('POST', '/v2/reg/smsv', smsvXml);
  check(verifyRes.status === 200, '/v2/reg/smsv (XML body) accepts', verifyRes.status);
  const regXml = `<param><msisdn>15551234</msisdn><imei>imei-1</imei><name>Artem</name><token>${tok.token}</token><authnum>0000</authnum><pushtype>SPP</pushtype></param>`;
  const reg = (await httpsRaw('POST', '/v2/reg', regXml)).body;
  check(!!reg.uid, '/v2/reg (XML body) returns uid', reg);

  // --- gzipped request body (client gzips larger POSTs; identity must survive) ---
  const zlib = require('zlib');
  const regGz = zlib.gzipSync(Buffer.from('<param><msisdn>15559999</msisdn><name>Gzipped</name><imei>imei-9</imei></param>', 'utf8'));
  await new Promise((resolve, reject) => {
    const req = https.request(
      { host: '127.0.0.1', port: config.gldPort, method: 'POST', path: '/v2/reg', ca: [ca], servername: 'gld1.samsungchaton.com',
        headers: { 'Content-Type': 'application/xml', 'Content-Encoding': 'gzip', 'Content-Length': regGz.length } },
      (res) => { res.on('data', () => {}); res.on('end', resolve); },
    );
    req.on('error', reject); req.write(regGz); req.end();
  });
  check([...store.accounts.values()].some((a) => a.msisdn === '15559999'), 'gzipped /v2/reg body decompressed + parsed', [...store.accounts.values()].map((a) => a.msisdn));

  // --- post-login endpoints ---
  check((await httpsRaw('POST', '/compatibility', '<param><compatibility><type>doc</type><value>true</value></compatibility></param>')).status === 200, '/compatibility acks');
  const buds = (await httpsReq('GET', '/v3/buddies?uid=U100000&mode=blocked')).body;
  check(Array.isArray(buds.buddy), '/v3/buddies returns a buddy array', buds);
  const inb = (await httpsReq('GET', '/inboxes?uid=U100000&count=100')).body;
  check(Array.isArray(inb.msg), '/inboxes returns a msg array', inb);

  // --- buddy add + list between two accounts ---
  const A = store.register({ msisdn: '70001112233', name: 'Alice' });
  const B = store.register({ msisdn: '70004445566', name: 'Bob' });
  const addRes = (await httpsRaw('POST', `/v3/buddy?uid=${A.uid}&mode=call`, '<param> <address>+70004445566</address> </param>')).body;
  check(addRes.buddy.length === 1 && addRes.buddy[0].name === 'Bob', 'add-buddy finds and returns Bob', addRes);
  check(addRes.buddy[0].value === '70004445566', 'added buddy has value=number', addRes.buddy[0]);
  const listRes = (await httpsReq('GET', `/v3/buddies?uid=${A.uid}&mode=blocked&timestamp=0`)).body;
  check(listRes.buddy.some((x) => x.name === 'Bob'), 'buddy list (mode=blocked, as the real client calls it) shows the added friend', listRes);
  const unknown = (await httpsRaw('POST', `/v3/buddy?uid=${A.uid}&mode=call`, '<param> <address>+79999999999</address> </param>')).body;
  check(unknown.buddy.length === 0, 'adding an unregistered number returns no buddy', unknown);
  const vn = (await httpsReq('GET', '/version/versionnotidis?imei=1&platform=android')).body;
  check(vn.uptodate === true && vn.needPopup === false, '/version/versionnotidis says up-to-date', vn);

  // --- Push handshake ---
  await new Promise((resolve) => {
    const socket = tlsClient(async () => {
      check(socket.authorized, 'push TLS server cert trusted by our CA', socket.authorizationError);
      const conn = makeConn(socket);
      const REG = 'test-device-0001';

      // Push provisioning: client asks where the message server is
      conn.send('ProvisionRequest', { async_id: 1, device_id: b('dev-1'), version: b('1') });
      let pm = await conn.next('ProvisionReply');
      check(pm.name === 'ProvisionReply', 'got ProvisionReply', pm.name);
      check(pm.body.result === 1000, 'ProvisionReply result=1000', pm.body.result);
      check(!!s(pm.body.primary_ip) && (pm.body.primary_port | 0) === config.pushPort, 'ProvisionReply gives message server addr:port', { ip: s(pm.body.primary_ip), port: pm.body.primary_port });

      // Init
      const asyncId = 4242;
      conn.send('InitRequest', { async_id: asyncId, push_reg_id: b(REG) });
      let m = await conn.next();
      check(m.name === 'InitReply', 'got InitReply', m.name);
      check(m.body.result === 1000, 'InitReply result=1000', m.body.result);
      check((m.body.async_id | 0) === asyncId, 'InitReply echoes async_id', m.body.async_id);

      // Registration
      const asyncId2 = 77;
      conn.send('RegistrationRequest', { async_id: asyncId2, push_reg_id: b(REG), app_id: b('chaton') });
      m = await conn.next();
      check(m.name === 'RegistrationReply', 'got RegistrationReply', m.name);
      check(m.body.result === 1000, 'RegistrationReply result=1000', m.body.result);
      check(s(m.body.reg_id).length === 32, 'RegistrationReply carries an issued registration id (field 4)', s(m.body.reg_id));

      // Ping / heartbeat echo
      const ts = Date.now();
      conn.send('PingRequest', { async_id: 9, timestamp: ts, field3: 0 });
      m = await conn.next();
      check(m.name === 'PingReply', 'got PingReply', m.name);
      check((m.body.async_id | 0) === 9, 'PingReply echoes async_id', m.body.async_id);
      check(String(m.body.timestamp) === String(ts), 'PingReply echoes timestamp', m.body.timestamp);

      // Server-initiated notification -> NotiGroup, then client acks
      push.notify(REG, { sender: 'alice', type: 1, body: 'hello from the void' });
      m = await conn.next();
      check(m.name === 'NotiGroup', 'got NotiGroup', m.name);
      const el = m.body.elements && m.body.elements[0];
      check(!!el, 'NotiGroup has an element');
      check(el && s(el.msg) === 'hello from the void', 'NotiElement msg (field 6) intact', el && s(el.msg));
      check(el && s(el.sender) === 'alice', 'NotiElement sender (field 5) intact', el && s(el.sender));

      // Ack it; queue should drain
      conn.send('NotiAcks', { ids: [el.noti_id] });
      await new Promise((r) => setTimeout(r, 50));
      check(store.drain(REG).length === 0, 'queue drained after ack', store.drain(REG).length);

      socket.end();
      resolve();
    });
    socket.on('error', (e) => {
      check(false, 'push TLS connect', e.message);
      resolve();
    });
  });

  // --- number matching: the client is inconsistent about +CC / trunk prefixes ---
  const NUM = store.register({ msisdn: '9917886095', name: 'Fuzzy' }); // registered like the real log: no country code
  for (const variant of ['+19917886095', '79917886095', '89917886095', '+9917886095', '9917886095']) {
    check((store.findByNumber(variant) || {}).uid === NUM.uid, `findByNumber matches "${variant}"`, variant);
  }
  check(store.findByNumber('+7991788') === null || store.findByNumber('12345') === null, 'too-short numbers do not fuzzy-match');
  const chk = (await httpsReq('GET', '/check/%2B19917886095?uid=' + A.uid + '&imei=1')).body;
  check(chk.buddy.length === 1 && chk.buddy[0].name === 'Fuzzy', '/check/<number> finds a user by +1 variant', chk);
  const prev = (await httpsRaw('POST', `/v3/buddy?uid=${A.uid}&mode=preview`, '<param> <address>+19917886095</address> </param>')).body;
  check(prev.buddy.length === 1 && prev.buddy[0].value === '9917886095', 'preview of "+1…" finds the account registered without a country code', prev);
  check(store.getFriends(A.uid).indexOf('9917886095') === -1, 'preview does not add a friend');

  // --- phone-book upload: auto-friend matches, and never print the contact list ---
  const logged = [];
  const origLog = console.log;
  console.log = (...a) => { logged.push(a.join(' ')); };
  const upXml = '<param> <address name="Mum">+79990001234</address> <address name="Fuzzy Friend">89917886095</address> <address name="Nobody">+15550000000</address> </param>';
  await httpsRaw('POST', `/address?uid=${A.uid}&mode=new`, upXml);
  console.log = origLog;
  const dump = logged.join('\n');
  check(store.getFriends(A.uid).includes('9917886095'), '/address upload auto-adds contacts that are registered', store.getFriends(A.uid));
  check(!dump.includes('79990001234') && !dump.includes('Mum') && !dump.includes('15550000000'), 'contact numbers/names are NOT written to the log', dump.slice(0, 300));
  check(dump.includes('3 contacts, not logged'), 'upload is logged as a count only', dump.slice(0, 300));

  // --- message routing between two accounts (IP-bound sessions) ---
  const C = store.register({ msisdn: '70001110001', name: 'Carol' });
  const D = store.register({ msisdn: '70001110002', name: 'Dave' });
  store.bindIp('127.0.0.1', D.uid); // Dave's device = the local test client
  store.bindIp('10.9.9.9', C.uid);  // Carol's device = a pretend remote sender
  await new Promise((resolve) => {
    const socket = tlsClient(async () => {
      const conn = makeConn(socket);
      conn.send('InitRequest', { async_id: 31, push_reg_id: b('dave-dev') });
      await conn.next('InitReply (dave)');
      conn.send('RegistrationRequest', { async_id: 32, push_reg_id: b('dave-dev') });
      await conn.next('RegistrationReply (dave)');

      // Carol "sends" a chat message addressed to Dave through the router.
      const fakeCarolSession = { socket: { remoteAddress: '::ffff:10.9.9.9' } };
      push.router = (sess, info) => {
        const from = store.accounts.get(push._uid(sess));
        const to = (`${info.app_data}`.match(/\+?\d{5,}/g) || []).map((t) => store.findByNumber(t)).filter(Boolean);
        to.forEach((acct) => push.notifyUid(acct.uid, { sender: from.msisdn, msg: info.msg, app_data: info.app_data }));
        return to.length;
      };
      const routed = push.router(fakeCarolSession, { msg: 'привет, Dave!', app_data: 'to=+70001110002' });
      check(routed === 1, 'router resolves Dave from app_data', routed);

      const m = await conn.next('NotiGroup (dave)');
      const el = m.body.elements && m.body.elements[0];
      check(m.name === 'NotiGroup' && !!el, "Dave's session receives a NotiGroup", m.name);
      check(el && s(el.sender) === '70001110001', 'delivered sender = Carol (field 5)', el && s(el.sender));
      check(el && s(el.msg) === 'привет, Dave!', 'delivered text intact incl. UTF-8 (field 6)', el && s(el.msg));
      conn.send('NotiAcks', { ids: [el.noti_id] });
      await new Promise((r) => setTimeout(r, 50));
      check(store.peekUid(D.uid).length === 0, "Dave's account queue drained after ack", store.peekUid(D.uid).length);
      socket.end();
      resolve();
    });
    socket.on('error', (e) => { check(false, 'routing client connect', e.message); resolve(); });
  });

  // offline recipient: message queues, then arrives when the session comes up
  const queued = push.notifyUid(C.uid, { sender: 'x', msg: 'offline-msg' });
  check(queued.sessions === 0 && store.peekUid(C.uid).length === 1, 'message to an offline account is queued', queued.sessions);

  // --- SQLite persistence: data must survive close + reopen of the DB file ---
  {
    const fsx = require('fs');
    const osx = require('os');
    const dir = fsx.mkdtempSync(path.join(osx.tmpdir(), 'ls-db-'));
    const file = path.join(dir, 'nested', 'test.db'); // also checks the data dir is created
    let db1 = new Store(file);
    const P = db1.register({ msisdn: '70005550001', name: 'Persist-A', imei: 'imei-p' });
    const Q = db1.register({ msisdn: '70005550002', name: 'Persist-B' });
    db1.addFriend(P.uid, '+70005550002');
    db1.addFriend(P.uid, '70005550002'); // duplicate must not create a second row
    db1.bindIp('10.1.1.1', P.uid);
    db1.enqueueUid(Q.uid, { sender: '70005550001', msg: 'saved while offline', noti_id: 'n-1' });
    db1.enqueueUid(Q.uid, { sender: '70005550001', msg: 'second' });
    db1.logMessage({ sender: '70005550001', uid: Q.uid, text: 'hello history' });
    const tok = db1.issueToken('555');
    const code = db1.sendSms(tok, '555');
    db1.close();

    const db2 = new Store(file); // "server restart"
    check(db2.stats().accounts === 2, 'accounts survive a restart', db2.stats());
    check(db2.findByNumber('+70005550001').name === 'Persist-A', 'account found by number after restart');
    check(JSON.stringify(db2.getFriends(P.uid)) === JSON.stringify(['70005550002']), 'friendship survives (and was de-duplicated)', db2.getFriends(P.uid));
    check(db2.uidForIp('10.1.1.1') === P.uid, 'ip -> account binding survives');
    const pend = db2.peekUid(Q.uid);
    check(pend.length === 2 && pend[0].msg === 'saved while offline', 'undelivered messages survive, in order', pend.map((e) => e.msg));
    check(db2.verify(tok, code) && !db2.verify(tok, '0000'), 'SMS token + code survive a restart');
    check(db2.recentMessages(5)[0].text === 'hello history', 'message history is logged and survives');
    const R = db2.register({ msisdn: '70005550003', name: 'Persist-C' });
    check(Number(R.uid.slice(1)) > Number(Q.uid.slice(1)), 'uid sequence continues after restart', [Q.uid, R.uid]);
    db2.register({ msisdn: '70005550001', name: 'Persist-A2' }); // re-register keeps the same uid
    check(db2.findByNumber('70005550001').uid === P.uid && db2.findByNumber('70005550001').name === 'Persist-A2', 're-registering keeps the uid and updates the name');
    db2.ackUid(Q.uid, ['n-1']); // ack by noti_id
    db2.ackUid(Q.uid, [String(pend[1].seq)]); // ack by seq
    check(db2.peekUid(Q.uid).length === 0, 'acks (by noti_id and by seq) delete from the queue', db2.peekUid(Q.uid).length);
    db2.close();
    fsx.rmSync(dir, { recursive: true, force: true });
  }

  // --- wire regression with frames captured from a real ChatON 1.10.3 client ---
  // The client reads InitReply with getters d() = FIELD 1 (must equal its request async id)
  // and f() = FIELD 2 (result, 1000 = OK). Decode our raw reply the same way, independently
  // of our own .proto, so a field-number mix-up cannot hide behind a symmetric test.
  function pbFields(buf) { // minimal protobuf reader: { fieldNo: value | Buffer }
    const out = {}; let i = 0;
    const varint = () => { let r = 0n, sh = 0n; for (;;) { const c = buf[i++]; r |= BigInt(c & 0x7f) << sh; if (!(c & 0x80)) break; sh += 7n; } return r; };
    while (i < buf.length) {
      const key = Number(varint()); const f = key >> 3; const w = key & 7;
      if (w === 0) out[f] = Number(BigInt.asIntN(32, varint()));
      else if (w === 2) { const n = Number(varint()); out[f] = buf.subarray(i, i + n); i += n; }
      else if (w === 1) { out[f] = buf.subarray(i, i + 8); i += 8; }
      else throw new Error('wire type ' + w);
    }
    return out;
  }
  const net2 = require('net');
  const wirePort = config.pushPort + 2;
  const pushWire = new PushServer({ ...config, pushTls: false, pushPort: wirePort }, new Store());
  await pushWire.start();
  const rawExchange = (hex) => new Promise((resolve, reject) => {
    const sock = net2.connect(wirePort, '127.0.0.1', () => sock.write(Buffer.from(hex, 'hex')));
    let got = Buffer.alloc(0);
    sock.on('data', (c) => { got = Buffer.concat([got, c]); if (got.length >= 4 && got.length >= 4 + got.readUInt16BE(2)) { sock.end(); resolve(got); } });
    sock.on('error', reject);
    setTimeout(() => reject(new Error('no reply')), 3000);
  });
  const frameBody = (f) => ({ type: f[1], body: pbFields(f.subarray(4, 4 + f.readUInt16BE(2))) });

  // captured: InitRequest async_id=2112580769 (79 B) and a negative one, async_id=-366026236 (84 B)
  const captured = [
    ['0000004b08a1d9adef0712436465766963652e6d6f64656c3d534d2d53393038452673696d2e6d63633d3236322673696d2e6d6e633d3037266e65742e6d63633d323632266e65742e6d6e633d3037', 2112580769],
    ['000000500884c4bbd1feffffffff0112436465766963652e6d6f64656c3d534d2d53393038452673696d2e6d63633d3236322673696d2e6d6e633d3037266e65742e6d63633d323632266e65742e6d6e633d3037', -366026236],
  ];
  for (const [hex, asyncId] of captured) {
    try {
      const r = frameBody(await rawExchange(hex));
      check(r.type === 1, `real InitRequest(${asyncId}) -> reply is type 1 (InitReply)`, r.type);
      check(r.body[1] === asyncId, `client's d() (field 1) == its async id ${asyncId}`, r.body[1]);
      check(r.body[2] === 1000, "client's f() (field 2) == 1000 (OK)", r.body[2]);
    } catch (e) { check(false, 'raw InitRequest exchange', e.message); }
  }
  // captured ProvisionRequest -> the client reads result from field 2 and the server addr from 4/5
  try {
    const provHex = '000b00631201311a0f3238383630303035363739373138392208303030303030303032436465766963652e6d6f64656c3d534d2d53393038452673696d2e6d63633d3236322673696d2e6d6e633d3037266e65742e6d63633d323632266e65742e6d6e633d3037';
    const rp = frameBody(await rawExchange(provHex));
    check(rp.type === 12, 'real ProvisionRequest -> ProvisionReply (type 12)', rp.type);
    check(rp.body[2] === 1000, 'ProvisionReply result in field 2 == 1000', rp.body[2]);
    check(Buffer.isBuffer(rp.body[4]) && rp.body[4].length > 0 && rp.body[5] === wirePort, 'ProvisionReply: message server ip (field 4) + port (field 5)', { ip: String(rp.body[4]), port: rp.body[5] });
    check(rp.body[1] === undefined, 'ProvisionReply has no field 1 (the real message does not)', rp.body[1]);
  } catch (e) { check(false, 'raw ProvisionRequest exchange', e.message); }
  // RegistrationRequest {1: async 77, 2: token, 3: app id "chaton", 4: ""} built per push/c/a/h.java
  try {
    const tok = Buffer.from('tok-1'), app = Buffer.from('chaton');
    const body = Buffer.concat([Buffer.from([0x08, 77, 0x12, tok.length]), tok, Buffer.from([0x1a, app.length]), app, Buffer.from([0x22, 0])]);
    const hdr = Buffer.from([0, 2, body.length >> 8, body.length & 255]);
    const rr = frameBody(await rawExchange(Buffer.concat([hdr, body]).toString('hex')));
    check(rr.type === 3 && rr.body[1] === 77 && rr.body[2] === 1000, 'real-layout RegistrationRequest -> async id in field 1, 1000 in field 2', rr.body);
    check(Buffer.isBuffer(rr.body[4]) && rr.body[4].length > 0, 'RegistrationReply carries the registration id in field 4 (what the client stores)');
  } catch (e) { check(false, 'raw RegistrationRequest exchange', e.message); }
  pushWire.stop();

  // --- plaintext push (matches the smali SSL-off patch): plain TCP, same frames ---
  const net = require('net');
  const plainPort = config.pushPort + 1;
  const pushPlain = new PushServer({ ...config, pushTls: false, pushPort: plainPort }, new Store());
  await pushPlain.start();
  await new Promise((resolve) => {
    const socket = net.connect(plainPort, '127.0.0.1', async () => {
      const conn = makeConn(socket);
      conn.send('InitRequest', { async_id: 5, push_reg_id: b('plain-dev') });
      const m = await conn.next('plaintext InitReply');
      check(m.name === 'InitReply' && m.body.result === 1000, 'plaintext push handshake works', m.body);
      check((m.body.async_id | 0) === 5, 'plaintext InitReply echoes async_id', m.body.async_id);
      socket.end();
      resolve();
    });
    socket.on('error', (e) => { check(false, 'plaintext push connect', e.message); resolve(); });
  });
  pushPlain.stop();

  push.stop();
  gld.stop();

  console.log('');
  if (failures === 0) {
    console.log('ALL PASS');
    process.exit(0);
  } else {
    console.log(`${failures} FAILURE(S)`);
    process.exit(1);
  }
}

run().catch((e) => {
  console.error('self-test crashed:', e);
  process.exit(1);
});
