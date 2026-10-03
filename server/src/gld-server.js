'use strict';

const fs = require('fs');
const zlib = require('zlib');
const https = require('https');
const { URL } = require('url');
const log = require('./log').make('rest');

// Request bodies are XML in the ChatOnXmlParser (util/o.java) shape:
//   <param><msisdn>..</msisdn><token>..</token><authnum>..</authnum></param>
// Responses, empirically, are parsed as JSON by the client, so we keep replying
// JSON. parseBody accepts XML (primary) or JSON (fallback) and returns a flat map.
function parseBody(raw) {
  const t = raw.trim();
  if (t.startsWith('{') || t.startsWith('[')) {
    try { return JSON.parse(t); } catch (_) { /* fall through */ }
  }
  const out = {};
  // leaf <key>value</key> pairs (value has no nested tags); the <param> wrapper
  // is skipped naturally because its content contains '<'.
  const re = /<([A-Za-z_][\w.-]*)>([^<]*)<\/\1>/g;
  let m;
  while ((m = re.exec(t)) !== null) {
    out[m[1]] = m[2].trim();
  }
  return out;
}

// One HTTPS server on 443 plays every REST role the client reaches by hostname:
//   GLD      -> gld1.samsungchaton.com : /prov, /prov3   (provisioning)
//   CONTACT  -> provisioned contact addr : /auth/join, /v2/reg, /v2/reg/smsv, /dereg ...
//   SMS      -> provisioned sms addr     : /sms/*
//   FILE     -> provisioned file addr    : media (stubbed)
// Responses are JSON; the client maps top-level keys straight onto Entry fields
// (util/o.java). Provisioning entries are classified by Server.name in
// {"contact","message","file","sms"} (d/a/ai.java, ah.java).

// The client serialises an `Address` (value + optional name/group) as
//   <address name="Bob">+79991112233</address>      (value = element TEXT, name = attribute)
// not as a nested <value> tag. We accept that form and, defensively, the nested one.
function extractAddresses(raw) {
  const out = [];
  const re = /<address\b[^>]*>([\s\S]*?)<\/address>/g;
  let m;
  while ((m = re.exec(raw)) !== null) {
    const nested = /<value>([^<]*)<\/value>/.exec(m[1]);
    const text = (nested ? nested[1] : m[1].replace(/<[^>]*>/g, '')).trim();
    text.split(',').map((t) => t.trim()).filter(Boolean).forEach((t) => out.push(t));
  }
  return out;
}

// Extract every occurrence of a leaf tag (e.g. all <value> in an address list).
function extractAll(raw, tag) {
  const out = [];
  const re = new RegExp(`<${tag}>([^<]*)</${tag}>`, 'g');
  let m;
  while ((m = re.exec(raw)) !== null) out.push(m[1].trim());
  return out;
}

class GldServer {
  constructor(config, store) {
    this.config = config;
    this.store = store;
  }

  start() {
    const handler = (req, res) => this._onRequest(req, res);
    this.servers = [];
    const listeners = [];

    // HTTPS listener (always, if certs exist) — the hardcoded https://gld1 call
    // needs it even in plaintext mode.
    if (fs.existsSync(this.config.serverCert)) {
      const https = require('https');
      const s = https.createServer(
        {
          key: fs.readFileSync(this.config.serverKey),
          cert: fs.readFileSync(this.config.serverCert),
          minVersion: 'TLSv1',
        },
        handler,
      );
      this.servers.push(s);
      listeners.push(
        new Promise((r) =>
          s.listen(this.config.gldPort, this.config.bindHost, () => {
            log.info(`listening on ${this.config.bindHost}:${this.config.gldPort} (HTTPS)`);
            r();
          }),
        ),
      );
    }

    // HTTP listener (for plaintext REST once contact/file/sms are advertised on
    // the http port, and for a GLD string patched to http://).
    const http = require('http');
    const hs = http.createServer(handler);
    this.servers.push(hs);
    listeners.push(
      new Promise((r) =>
        hs.listen(this.config.gldHttpPort, this.config.bindHost, () => {
          log.info(`listening on ${this.config.bindHost}:${this.config.gldHttpPort} (HTTP)`);
          r();
        }),
      ),
    );

    return Promise.all(listeners);
  }
  stop() {
    for (const s of this.servers || []) s.close();
  }

  // contact/file/sms role port decides the client's scheme (ba.l(): 443=>https,
  // else http). restTls picks which we advertise. message is the push channel.
  _restPort() {
    return this.config.restTls ? this.config.gldPort : this.config.gldHttpPort;
  }
  _servers(withSms) {
    const h = this.config.publicHost;
    const p = this._restPort();
    const list = [
      { address: h, name: 'contact', port: p, region: 'local' },
      { address: h, name: 'message', port: this.config.pushPort, region: 'local' },
      { address: h, name: 'file', port: p, region: 'local' },
    ];
    if (withSms) list.push({ address: h, name: 'sms', port: p, region: 'local' });
    return list;
  }

  _prov() {
    return {
      expdate: Date.now() + this.config.provTtlMs,
      primary: this._servers(false),
      secondary: this._servers(false),
    };
  }
  _prov3(q) {
    return {
      expdate: Date.now() + this.config.provTtlMs,
      msisdn: q.get('phonenumber') || q.get('msisdn') || '',
      selfsmspn: '',
      primary: this._servers(true),
      secondary: this._servers(true),
    };
  }

  _json(res, obj, path) {
    const body = JSON.stringify(obj);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(body);
    log.info('->', path, body);
  }

  // Build a Buddy entry (io.entry.inner.Buddy) from an account. `value` is the
  // buddy's number/id (Entry.value); no avatar => imgstatus NONE_PROFILE ("3").
  _buddy(acct, orgnum) {
    return {
      value: acct.msisdn,
      name: acct.name || acct.msisdn,
      status: acct.status || '',
      orgnum: orgnum ? String(orgnum).replace(/^\+/, '') : acct.msisdn,
      orgname: acct.name || '',
      showphonenumber: true,
      imgstatus: '3',
      group: '',
      deleted: false,
      blocked: false,
    };
  }

  _onRequest(req, res) {
    const u = new URL(req.url, `https://${req.headers.host || 'gld'}`);
    const q = u.searchParams;
    const p = u.pathname;

    let bodyChunks = [];
    req.on('data', (c) => bodyChunks.push(c));
    req.on('end', () => {
      let buf = Buffer.concat(bodyChunks);
      const enc = (req.headers['content-encoding'] || '').toLowerCase();
      if (buf.length && enc.includes('gzip')) {
        try { buf = zlib.gunzipSync(buf); } catch (e) { log.warn('gunzip failed', e.message); }
      } else if (buf.length && enc.includes('deflate')) {
        try { buf = zlib.inflateSync(buf); } catch (_) { try { buf = zlib.inflateRawSync(buf); } catch (e) { log.warn('inflate failed', e.message); } }
      }
      const raw = buf.toString('utf8');
      const binary = buf.length > 0 && /[\x00-\x08\x0E-\x1F\uFFFD]/.test(raw);
      const body = raw && !binary ? parseBody(raw) : null;
      // Remember which device IP belongs to which account (used to route push messages).
      const ip = String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
      if (q.get('uid') && this.store.accounts.has(q.get('uid'))) this.store.bindIp(ip, q.get('uid'));
      const SENSITIVE = new Set(['/address']); // phone-book uploads: never echo to the console
      const shown = SENSITIVE.has(p) ? `body=<${extractAddresses(raw).length} contacts, not logged>` : binary ? `body(binary ${buf.length}B hex)=${buf.toString('hex').slice(0, 400)}` : `body=${raw.replace(/\s+/g, ' ').slice(0, 500)}`;
      log.info(req.method, p, Object.fromEntries(q.entries()), raw ? shown : '');
      this._route(req, res, u, q, body, raw);
    });
  }

  _route(req, res, u, q, body, raw) {
    const p = u.pathname;

    // --- provisioning ---
    if (p === '/prov') return this._json(res, this._prov(), p);
    if (p === '/prov3') return this._json(res, this._prov3(q), p);

    // --- version / update check ---
    if (p === '/version/versionnotidis') {
      // Tell the client it's current so no update popup blocks the flow.
      return this._json(res, { uptodate: true, critical: false, needPopup: false, notice: 0 }, p);
    }
    if (p === '/version') {
      return this._json(res, { uptodate: true, newversion: '1.10.3' }, p);
    }
    if (p === '/disclaimer/accept') {
      return this._json(res, {}, p);
    }

    // --- post-login screens (empty but well-formed so populated data works later) ---
    if (p === '/notification') {
      return this._json(res, {}, p); // binary (protobuf) body is hex-dumped above
    }
    if (p === '/inbox') {
      return this._json(res, {}, p); // "mark as read" ack
    }
    if (p === '/compatibility') {
      return this._json(res, {}, p); // capability ack; client only needs success
    }
    // --- buddies ---
    // Add / preview a buddy by phone number(s). Body: <address>+N</address>... Modes seen in
    // the client: preview (look up), call (add one), multiple (add several). Reply: GetBuddyList.
    if (p === '/v3/buddy') {
      const mode = q.get('mode') || 'call';
      const me = this.store.accounts.get(q.get('uid'));
      const numbers = extractAddresses(raw || '');
      const buddies = [];
      for (const num of numbers) {
        const acct = this.store.findByNumber(num);
        if (!acct || (me && acct.uid === me.uid)) continue; // unknown number, or yourself
        if (mode !== 'preview' && me) this.store.addFriend(me.uid, acct.msisdn);
        buddies.push(this._buddy(acct, num));
      }
      log.info(`buddy ${mode}: ${numbers.length} number(s) -> ${buddies.length} found`);
      return this._json(res, { buddy: buddies }, p);
    }
    // "Is this number on ChatON?" (GET /check/<number>) -> GetBuddyList
    if (p.startsWith('/check/')) {
      const num = decodeURIComponent(p.slice('/check/'.length));
      const acct = this.store.findByNumber(num);
      return this._json(res, { buddy: acct ? [this._buddy(acct, num)] : [] }, p);
    }
    // Full buddy-list sync. NOTE: the real client ALWAYS sends mode=blocked here (it is the
    // standard "get all buddies" call, with blocked ones flagged), so the mode must not be
    // used to return an empty list.
    if (p === '/v3/buddies') {
      const me = this.store.accounts.get(q.get('uid'));
      const buddy = me
        ? this.store.getFriends(me.uid).map((n) => this.store.findByNumber(n)).filter(Boolean).map((a) => this._buddy(a))
        : [];
      return this._json(res, { timestamp: Date.now(), buddy }, p);
    }
    // Phone-book upload (<address name="Bob">NUMBER</address> x N). In the original service,
    // contacts who were on ChatON showed up as friends automatically — do the same, and keep
    // nothing but the resulting friendships (the contact list itself is not stored or logged).
    if (p === '/address') {
      const me = this.store.accounts.get(q.get('uid'));
      let matched = 0;
      if (me && q.get('mode') !== 'delete') {
        for (const num of extractAddresses(raw || '')) {
          const acct = this.store.findByNumber(num);
          if (acct && acct.uid !== me.uid) { this.store.addFriend(me.uid, acct.msisdn); matched++; }
        }
      }
      log.info(`contacts uploaded for ${me ? me.name : '?'}: ${matched} matched a registered account`);
      return this._json(res, {}, p);
    }
    if (p === '/inboxes') {
      return this._json(res, { msg: [] }, p); // GetUnReadMessageList
    }
    if (p === '/buddyrecommendeelist' || p === '/specialbuddy/specialusers' || p === '/specialbuddy/myfollowings') {
      return this._json(res, { buddy: [] }, p);
    }

    // --- registration (CONTACT) ---
    if (p === '/auth/join') {
      // skip-SMS registration: body {imei, pushtype, osversion, imsi, model, name}
      const acct = this.store.register({ name: body && body.name, imei: body && body.imei });
      log.info('registered (skip-SMS)', acct.uid, 'chatonid=' + acct.chatonid, 'name=' + acct.name);
      return this._json(res, { chatonid: acct.chatonid, uid: acct.uid }, p);
    }
    if (p === '/v2/reg') {
      // full registration: body {msisdn, imei, name, token, authnum, ...}
      const acct = this.store.register({
        msisdn: body && body.msisdn,
        name: body && body.name,
        imei: body && body.imei,
      });
      log.info('registered', acct.uid, 'msisdn=' + acct.msisdn, 'name=' + acct.name);
      return this._json(res, { uid: acct.uid }, p);
    }
    if (p === '/v2/reg/smsv') {
      const ok = this.store.verify(body && body.token, body && body.authnum);
      log.info('verify sms', ok ? 'OK' : 'MISMATCH', 'msisdn=' + (body && body.msisdn));
      return this._json(res, {}, p); // client only checks success (HTTP 200)
    }
    if (p === '/dereg') {
      log.info('dereg uid=' + q.get('uid'));
      return this._json(res, {}, p);
    }

    // --- SMS gateway ---
    if (p === '/sms/v2/authtoken' || p === '/sms/acs/v2/authtoken') {
      const token = this.store.issueToken(q.get('phonenumber'));
      return this._json(res, { token }, p);
    }
    if (p === '/sms/v3/send' || p === '/sms/acs/v2/req') {
      const token = req.headers['sms-token'] || q.get('sms-token');
      const phone = q.get('phonenumber');
      const authnum = this.store.sendSms(token, phone);
      // No real SMS gateway: print the code so it can be typed into the app.
      log.info('=========================================');
      log.info(`  SMS auth code for ${q.get('countrycallingcode') || ''}${phone || ''}: ${authnum}`);
      log.info('=========================================');
      return this._json(res, {}, p);
    }

    // --- everything else: log + empty 200 so the client keeps moving; the log
    // makes the next endpoint to implement obvious. ---
    log.warn('unimplemented', req.method, p, '-> empty 200 (trace me next)');
    if (raw) log.info('  req body:', raw.slice(0, 2000));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{}');
  }
}

module.exports = { GldServer };
