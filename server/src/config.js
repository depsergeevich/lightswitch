'use strict';

const path = require('path');

const CERT_DIR = process.env.LS_CERT_DIR || path.join(__dirname, '..', '..', 'certs');
const bool = (v, def) => (v == null ? def : !(v === '0' || String(v).toLowerCase() === 'false'));

module.exports = {
  // --- push front-end ---
  // TLS on by default (unmodified client). Set LS_PUSH_TLS=0 to run plaintext,
  // which matches the smali patch that flips the SSL flag off in
  // push/b/a/c.smali and d.smali (no spp916.bks needed then).
  pushTls: bool(process.env.LS_PUSH_TLS, false),
  pushPort: Number(process.env.LS_PUSH_PORT || 5223),

  // --- REST (GLD / contact / file / sms) ---
  // The REST server always binds HTTPS on gldPort and (when a plain port is set)
  // HTTP on gldHttpPort, so the hardcoded https://gld1 provisioning call works
  // even in plaintext mode. restTls only decides which SCHEME/PORT is advertised
  // for the contact/file/sms roles (client picks http vs https by port: ba.l()).
  restTls: bool(process.env.LS_REST_TLS, false),
  gldPort: Number(process.env.LS_GLD_PORT || 443), // HTTPS
  gldHttpPort: Number(process.env.LS_GLD_HTTP_PORT || 80), // HTTP

  // Public address advertised in the provisioning reply (the IP the *device* can
  // reach). Set LS_PUBLIC_HOST to your server's LAN IP.
  publicHost: process.env.LS_PUBLIC_HOST || '192.168.0.20',
  bindHost: process.env.LS_BIND_HOST || '0.0.0.0',

  // TLS material (see certs/gen-certs.sh). Only needed when a TLS listener runs.
  certDir: CERT_DIR,
  serverKey: path.join(CERT_DIR, 'server.key'),
  serverCert: path.join(CERT_DIR, 'server.crt'),
  caCert: path.join(CERT_DIR, 'ca.crt'),

  provTtlMs: Number(process.env.LS_PROV_TTL_MS || 24 * 60 * 60 * 1000),
};
