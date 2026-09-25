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
  const addRes = (await httpsRaw('POST', `/v3/buddy?uid=${A.uid}&mode=call`, '<param><address><value>+70004445566</value></address></param>')).body;
  check(addRes.buddy.length === 1 && addRes.buddy[0].name === 'Bob', 'add-buddy finds and returns Bob', addRes);
  check(addRes.buddy[0].value === '70004445566', 'added buddy has value=number', addRes.buddy[0]);
  const listRes = (await httpsReq('GET', `/v3/buddies?uid=${A.uid}&mode=all`)).body;
  check(listRes.buddy.some((x) => x.name === 'Bob'), 'buddy list shows the added friend', listRes);
  const unknown = (await httpsRaw('POST', `/v3/buddy?uid=${A.uid}&mode=call`, '<param><address><value>+79999999999</value></address></param>')).body;
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
      check(s(m.body.reg_id) === REG, 'RegistrationReply returns reg_id', s(m.body.reg_id));

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
      check(el && s(el.body) === 'hello from the void', 'NotiElement body intact', el && s(el.body));
      check(el && s(el.sender) === 'alice', 'NotiElement sender intact', el && s(el.sender));

      // Ack it; queue should drain
      conn.send('NotiAcks', { ids: [b(String(el.seq))] });
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
