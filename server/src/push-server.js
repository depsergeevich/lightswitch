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
      case 'DeregistrationRequest':
        return this._send(sess, 'DeregistrationReply', {
          result: RESULT_OK,
          async_id: m.body.async_id | 0,
        });
      default:
        log.warn('unhandled', m.name);
    }
  }

  // Push-side provisioning (ProvMessageTask): reply with the real message
  // server address/port so the client reconnects there for Init/Registration.
  // result=1000 required; primary/secondary point at our push front-end.
  _onProvision(sess, body) {
    const h = this.config.publicHost;
    const port = this.config.pushPort;
    this._send(sess, 'ProvisionReply', {
      async_id: body.async_id | 0,
      result: RESULT_OK,
      device_token: b(body.device_token && s(body.device_token) ? s(body.device_token) : `tok-${Date.now()}`),
      primary_ip: b(h),
      primary_port: port,
      secondary_ip: b(h),
      secondary_port: port,
      ping_config: b('ping_min=4&ping_avg=4&ping_max=24&ping_inc=4'),
    });
  }

  _onInit(sess, body) {
    sess.pushRegId = body.push_reg_id ? s(body.push_reg_id) : `dev-${sess.remote}`;
    const dev = this.store.device(sess.pushRegId);
    dev.connected = true;
    // result=1000 + echo async_id => client marks init done and starts HeartBeat.
    this._send(sess, 'InitReply', {
      result: RESULT_OK,
      async_id: body.async_id | 0,
      payload: b(''),
    });
  }

  _onRegister(sess, body) {
    const regId = body.push_reg_id ? s(body.push_reg_id) : sess.pushRegId;
    sess.pushRegId = regId;
    sess.registered = true;
    this.store.device(regId).connected = true;
    this._send(sess, 'RegistrationReply', {
      result: RESULT_OK,
      async_id: body.async_id | 0,
      reg_id: b(regId),
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
    log.info('acked', sess.remote, ids);
  }

  // Push all pending NotiElements for this session's device as one NotiGroup.
  flush(sess) {
    if (!sess.pushRegId) return;
    const pending = this.store.drain(sess.pushRegId);
    if (!pending.length) return;
    this._send(sess, 'NotiGroup', {
      elements: pending.map((e) => ({
        noti_id: b(e.noti_id != null ? e.noti_id : e.seq),
        sender: b(e.sender || ''),
        type: e.type | 0,
        subtype: e.subtype | 0,
        target: b(e.target || ''),
        body: b(e.body || ''),
        extra: b(e.extra || ''),
        timestamp: e.timestamp || Date.now(),
        seq: e.seq | 0,
        aux: b(e.aux || ''),
      })),
    });
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
