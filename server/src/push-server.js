'use strict';

const fs = require('fs');
const tls = require('tls');
const net = require('net');
const { encodeFrame, decodeFrames, b, s } = require('./proto');
const log = require('./log').make('push');

const RESULT_OK = 1000; // InitReply/RegistrationReply success code (push/c/a/b.java, h.java)

class PushServer {
  constructor(config, store) {
    this.config = config;
    this.store = store;
    this.sessions = new Set();
  }

  start() {
    const useTls = this.config.pushTls;
    if (useTls) {
      const opts = {
        key: fs.readFileSync(this.config.serverKey),
        cert: fs.readFileSync(this.config.serverCert),
        // The client presents no client cert (spp916.bks holds only trusted
        // certs, no PrivateKeyEntry), so we don't request one.
        requestCert: false,
        minVersion: 'TLSv1', // old 2012 client
      };
      this.server = tls.createServer(opts, (socket) => this._onConnect(socket));
      this.server.on('tlsClientError', (err) => log.warn('tlsClientError', err.message));
    } else {
      // Plaintext push: matches the smali patch (SSL flag flipped off). The
      // frame codec is identical; only the transport differs.
      this.server = net.createServer((socket) => this._onConnect(socket));
    }
    return new Promise((resolve) => {
      this.server.listen(this.config.pushPort, this.config.bindHost, () => {
        log.info(
          `listening on ${this.config.bindHost}:${this.config.pushPort} (${useTls ? 'TLS' : 'PLAINTEXT'})`,
        );
        resolve();
      });
    });
  }

  stop() {
    if (this.server) this.server.close();
    for (const sess of this.sessions) sess.socket.destroy();
  }

  _onConnect(socket) {
    const sess = {
      socket,
      remote: `${socket.remoteAddress}:${socket.remotePort}`,
      buf: Buffer.alloc(0),
      pushRegId: null,
      registered: false,
    };
    this.sessions.add(sess);
    log.info('connected', sess.remote);

    socket.on('data', (chunk) => {
      if (process.env.LS_DEBUG) log.info('RAW<-', sess.remote, chunk.length + 'B', chunk.toString('hex'));
      sess.buf = Buffer.concat([sess.buf, chunk]);
      const { messages, rest } = decodeFrames(sess.buf);
      sess.buf = rest;
      for (const m of messages) this._dispatch(sess, m);
    });
    socket.on('error', (err) => log.warn('socket error', sess.remote, err.message));
    socket.on('close', () => {
      this.sessions.delete(sess);
      if (sess.pushRegId) this.store.device(sess.pushRegId).connected = false;
      log.info('closed', sess.remote);
    });
  }

  _ip(sess) { return String(sess.socket.remoteAddress || '').replace(/^::ffff:/, ''); }
  _uid(sess) { return this.store.uidForIp(this._ip(sess)); }

  _send(sess, name, body) {
    try {
      sess.socket.write(encodeFrame(name, body));
      log.info('->', sess.remote, name, this._peek(body));
    } catch (e) {
      log.err('encode/send failed', name, e.message);
    }
  }

  _peek(body) {
    const o = {};
    for (const [k, v] of Object.entries(body)) {
      o[k] = Buffer.isBuffer(v) ? s(v) : v;
    }
    return JSON.stringify(o);
  }

  _dispatch(sess, m) {
    log.info('<-', sess.remote, m.name, this._peek(m.body));
    switch (m.name) {
      case 'InitRequest':
        return this._onInit(sess, m.body);
      case 'RegistrationRequest':
        return this._onRegister(sess, m.body);
      case 'PingRequest':
        return this._onPing(sess, m.body);
      case 'NotiAcks':
        return this._onAcks(sess, m.body);
      case 'ProvisionRequest':
        return this._onProvision(sess, m.body);
      case 'NotiElement':
        return this._onClientNoti(sess, m.body);
      case 'DeregistrationRequest':
        return this._send(sess, 'DeregistrationReply', {
          result: RESULT_OK,
          async_id: m.body.async_id | 0,
        });
      default:
        // Unknown/unmodelled frame: dump the raw body so it can be reverse-engineered.
        log.warn('unhandled', m.name, m.body && m.body._raw ? 'raw=' + Buffer.from(m.body._raw).toString('hex') : '');
    }
  }

  // Push-side provisioning (ProvMessageTask): reply with the real message
  // server address/port so the client reconnects there for Init/Registration.
  // result=1000 required; primary/secondary point at our push front-end.
  _onProvision(sess, body) {
    const h = this.config.publicHost;
    const port = this.config.pushPort;
    this._send(sess, 'ProvisionReply', {
      result: RESULT_OK,
      device_token: b(body.device_token && s(body.device_token) ? s(body.device_token) : `tok-${Date.now()}`),
      primary_ip: b(h),
      primary_port: port,
      secondary_ip: b(h),
      secondary_port: port,
      ping_config: b('ping_min=4&ping_avg=4&ping_max=24&ping_inc=4'),
    });
  }

  // EXPERIMENTAL: a client sending a NotiElement to the server (an outbound chat
  // message). The exact outbound transport is not yet confirmed on a real device;
  // this logs the frame in full and, if the recipient can be resolved from
  // app_data/session_info as a registered number, relays it to that device.
  _onClientNoti(sess, body) {
    const text = body.msg ? s(body.msg) : '';
    const info = {
      sender: body.sender ? s(body.sender) : '',
      msg: text,
      app_data: body.app_data ? s(body.app_data) : '',
      session_info: body.session_info ? s(body.session_info) : '',
    };
    log.info('client NotiElement (outbound chat?)', JSON.stringify(info));
    if (!this.router) return;
    const delivered = this.router(sess, info);
    log.info(delivered ? `routed to ${delivered} recipient account(s)` : 'no recipient resolved — frame logged only');
  }

  _onInit(sess, body) {
    sess.pushRegId = body.push_reg_id ? s(body.push_reg_id) : `dev-${sess.remote}`;
    const dev = this.store.device(sess.pushRegId);
    dev.connected = true;
    // result=1000 + echo async_id => client marks init done and starts HeartBeat.
    this._send(sess, 'InitReply', {
      async_id: body.async_id | 0, // field 1 — the client compares this with its request id
      result: RESULT_OK, //            field 2 — 1000 = OK
    });
  }

  _onRegister(sess, body) {
    const regId = body.push_reg_id ? s(body.push_reg_id) : sess.pushRegId;
    sess.pushRegId = regId;
    sess.registered = true;
    this.store.device(regId).connected = true;
    const appId = body.app_id ? s(body.app_id) : '';
    const issuedRegId = require('crypto').createHash('sha1').update(`${regId}|${appId}`).digest('hex').slice(0, 32);
    this._send(sess, 'RegistrationReply', {
      async_id: body.async_id | 0,
      result: RESULT_OK,
      reg_id: b(issuedRegId),
    });
    // Deliver anything queued for this device.
    this.flush(sess);
  }

  _onPing(sess, body) {
    // Echo async_id + timestamp; keeps the heartbeat alive.
    this._send(sess, 'PingReply', {
      async_id: body.async_id | 0,
      timestamp: body.timestamp || Date.now(),
      field3: body.field3 | 0,
    });
    this.flush(sess);
  }

  _onAcks(sess, body) {
    const ids = (body.ids || []).map((x) => s(x));
    if (sess.pushRegId) this.store.ack(sess.pushRegId, ids);
    const uid = this._uid(sess);
    if (uid) this.store.ackUid(uid, ids);
    log.info('acked', sess.remote, ids);
  }

  // Push all pending NotiElements for this session's device as one NotiGroup.
  flush(sess) {
    if (!sess.pushRegId) return;
    const uid = this._uid(sess);
    const pending = this.store.drain(sess.pushRegId).concat(uid ? this.store.peekUid(uid) : []);
    if (!pending.length) return;
    this._send(sess, 'NotiGroup', {
      elements: pending.map((e) => ({
        noti_id: b(e.noti_id != null ? e.noti_id : e.seq),
        sender: b(e.sender || ''), // field 5 — the client reads the sender here
        msg: b(e.msg != null ? e.msg : e.body || ''), // field 6 — message text
        app_data: b(e.app_data || ''),
        timestamp: e.timestamp || Date.now(),
        conn_term: e.conn_term | 0,
        session_info: b(e.session_info || ''),
      })),
    });
  }

  // Deliver to every connected session that belongs to `uid` (resolved by IP);
  // queued for later if the account has no live session. Returns { el, sessions }.
  notifyUid(uid, element) {
    const el = this.store.enqueueUid(uid, element);
    this.store.logMessage({ sender: element.sender, uid, text: element.msg != null ? element.msg : element.body });
    let sessions = 0;
    for (const sess of this.sessions) {
      if (sess.pushRegId && this._uid(sess) === uid) { this.flush(sess); sessions++; }
    }
    return { el, sessions };
  }

  // Public API: push a notification to a device (delivers immediately if online).
  notify(pushRegId, element) {
    const el = this.store.enqueue(pushRegId, element);
    for (const sess of this.sessions) {
      if (sess.pushRegId === pushRegId) this.flush(sess);
    }
    return el;
  }
}

module.exports = { PushServer };
