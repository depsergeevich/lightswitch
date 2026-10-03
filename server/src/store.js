'use strict';

// Persistent store on node:sqlite (built into Node >= 22.13, no native deps).
//
// Same public API as the old in-memory store, so push-server / gld-server /
// index.js did not have to change. Pass ':memory:' (the default) for an
// ephemeral DB — that is what the self-test uses.
//
// Persisted: accounts (+ every number that resolves to them), friendships, SMS
// tokens, ip->account bindings, undelivered push notifications, message log.
// Not persisted: which push sessions are connected right now (runtime state).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

const SCHEMA_VERSION = 1;
const DAY_MS = 24 * 60 * 60 * 1000;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS accounts (
  uid        TEXT PRIMARY KEY,
  msisdn     TEXT NOT NULL,
  chatonid   TEXT NOT NULL,
  name       TEXT NOT NULL,
  imei       TEXT,
  status     TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
-- every number/id that resolves to an account (msisdn and chatonid)
CREATE TABLE IF NOT EXISTS account_numbers (
  number TEXT PRIMARY KEY,
  uid    TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS friends (
  uid      TEXT NOT NULL,
  number   TEXT NOT NULL,
  added_at INTEGER NOT NULL,
  PRIMARY KEY (uid, number)
);
CREATE TABLE IF NOT EXISTS sms_tokens (
  token      TEXT PRIMARY KEY,
  phone      TEXT,
  authnum    TEXT,
  created_at INTEGER NOT NULL
);
-- LAN heuristic: REST carries uid, push frames do not; both come from one device IP.
CREATE TABLE IF NOT EXISTS ip_bindings (
  ip         TEXT PRIMARY KEY,
  uid        TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
-- undelivered push notifications; addressed to an account (uid) or a raw push reg id
CREATE TABLE IF NOT EXISTS queue (
  seq         INTEGER PRIMARY KEY AUTOINCREMENT,
  uid         TEXT,
  push_reg_id TEXT,
  noti_id     TEXT,
  payload     TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS queue_uid ON queue(uid);
CREATE INDEX IF NOT EXISTS queue_reg ON queue(push_reg_id);
-- history of everything routed through the server
CREATE TABLE IF NOT EXISTS messages (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  sender        TEXT,
  recipient_uid TEXT,
  text          TEXT,
  ts            INTEGER NOT NULL
);
`;

function genAuthNum() {
  return String(Math.floor(1000 + Math.random() * 9000)); // 4-digit (client input field)
}
function genToken() {
  return crypto.randomBytes(16).toString('hex');
}
// node:sqlite throws on `undefined` bindings, so normalise.
const nz = (v) => (v === undefined ? null : v);

// Map-like read facade so existing code (`store.accounts.get/has/values`) keeps working.
class AccountsView {
  constructor(store) { this.store = store; }
  get(uid) { return this.store._account(uid) || undefined; }
  has(uid) { return !!this.store._account(uid); }
  values() { return this.store._allAccounts().values(); }
  get size() { return this.store._allAccounts().length; }
}

class Store {
  constructor(dbPath = ':memory:') {
    if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
    this.dbPath = dbPath;
    this.db = new DatabaseSync(dbPath);
    if (dbPath !== ':memory:') this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA synchronous = NORMAL;');
    this._migrate();

    this.accounts = new AccountsView(this);
    this.devices = new Map(); // runtime only: pushRegId -> { pushRegId, msisdn, connected }
    this._purgeOldTokens();
  }

  // ---- schema / lifecycle ----
  _migrate() {
    const v = this.db.prepare('PRAGMA user_version').get().user_version;
    if (v > SCHEMA_VERSION) {
      throw new Error(`database schema v${v} is newer than this server (v${SCHEMA_VERSION})`);
    }
    this.db.exec(SCHEMA);
    if (v < SCHEMA_VERSION) this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  }
  _tx(fn) {
    this.db.exec('BEGIN');
    try {
      const r = fn();
      this.db.exec('COMMIT');
      return r;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }
  _purgeOldTokens() {
    this.db.prepare('DELETE FROM sms_tokens WHERE created_at < ?').run(Date.now() - DAY_MS);
  }
  close() {
    try { this.db.close(); } catch (_) { /* already closed */ }
  }
  stats() {
    const n = (sql) => this.db.prepare(sql).get().n;
    return {
      accounts: n('SELECT COUNT(*) n FROM accounts'),
      friendships: n('SELECT COUNT(*) n FROM friends'),
      queued: n('SELECT COUNT(*) n FROM queue'),
      messages: n('SELECT COUNT(*) n FROM messages'),
    };
  }

  // ---- push devices (runtime state only) ----
  device(pushRegId) {
    let d = this.devices.get(pushRegId);
    if (!d) {
      d = { pushRegId, msisdn: null, connected: false };
      this.devices.set(pushRegId, d);
    }
    return d;
  }

  // ---- notification queue: per push registration id ----
  _enqueue(uid, pushRegId, element) {
    const notiId = element.noti_id != null ? String(element.noti_id) : null;
    const r = this.db
      .prepare('INSERT INTO queue(uid, push_reg_id, noti_id, payload, created_at) VALUES (?,?,?,?,?)')
      .run(nz(uid), nz(pushRegId), notiId, JSON.stringify(element), Date.now());
    return { ...element, seq: Number(r.lastInsertRowid) };
  }
  _peek(column, value) {
    return this.db
      .prepare(`SELECT seq, payload FROM queue WHERE ${column} = ? ORDER BY seq`)
      .all(value)
      .map((row) => ({ ...JSON.parse(row.payload), seq: row.seq }));
  }
  _ack(column, value, ids) {
    const del = this.db.prepare(
      `DELETE FROM queue WHERE ${column} = ? AND (CAST(seq AS TEXT) = ? OR noti_id = ?)`,
    );
    this._tx(() => ids.forEach((id) => del.run(value, String(id), String(id))));
  }

  enqueue(pushRegId, element) { return this._enqueue(null, pushRegId, element); }
  drain(pushRegId) { return this._peek('push_reg_id', pushRegId); }
  ack(pushRegId, ids) { this._ack('push_reg_id', pushRegId, ids); }

  // ---- notification queue: per account ----
  enqueueUid(uid, element) { return this._enqueue(uid, null, element); }
  peekUid(uid) { return this._peek('uid', uid); }
  ackUid(uid, ids) { this._ack('uid', uid, ids); }

  // ---- ip <-> uid binding ----
  bindIp(ip, uid) {
    if (!ip || !uid) return;
    this.db
      .prepare(
        `INSERT INTO ip_bindings(ip, uid, updated_at) VALUES (?,?,?)
         ON CONFLICT(ip) DO UPDATE SET uid = excluded.uid, updated_at = excluded.updated_at`,
      )
      .run(ip, uid, Date.now());
  }
  uidForIp(ip) {
    if (!ip) return null;
    const row = this.db.prepare('SELECT uid FROM ip_bindings WHERE ip = ?').get(ip);
    return row ? row.uid : null;
  }

  // ---- accounts / registration ----
  _account(uid) {
    if (uid == null) return null;
    const row = this.db
      .prepare('SELECT uid, msisdn, chatonid, name, imei, status FROM accounts WHERE uid = ?')
      .get(uid);
    return row ? { ...row } : null;
  }
  _allAccounts() {
    return this.db
      .prepare('SELECT uid, msisdn, chatonid, name, imei, status FROM accounts ORDER BY uid')
      .all()
      .map((r) => ({ ...r }));
  }
  _uidByNumber(number) {
    const row = this.db.prepare('SELECT uid FROM account_numbers WHERE number = ?').get(String(number));
    return row ? row.uid : null;
  }
  _nextUid() {
    // ChatON uids are opaque strings; U<n> with n continuing from the highest stored.
    const r = this.db
      .prepare("SELECT MAX(CAST(SUBSTR(uid, 2) AS INTEGER)) AS m FROM accounts WHERE uid GLOB 'U[0-9]*'")
      .get();
    return `U${Math.max(100000, (r.m || 0) + 1)}`;
  }

  // Register (or re-register) an account. `chatonid` defaults to msisdn; for the
  // skip-SMS path there may be no phone number, so a chatonid is minted.
  register({ msisdn, name, imei, chatonid }) {
    return this._tx(() => {
      let uid = msisdn ? this._uidByNumber(msisdn) : null;
      if (!uid) uid = this._nextUid();
      const cid = chatonid || msisdn || `local-${uid}`;
      const num = msisdn || cid;
      this.db
        .prepare(
          `INSERT INTO accounts(uid, msisdn, chatonid, name, imei, created_at) VALUES (?,?,?,?,?,?)
           ON CONFLICT(uid) DO UPDATE SET msisdn = excluded.msisdn, chatonid = excluded.chatonid,
             name = excluded.name, imei = excluded.imei`,
        )
        .run(uid, num, cid, name || cid, nz(imei), Date.now());
      const link = this.db.prepare(
        `INSERT INTO account_numbers(number, uid) VALUES (?,?)
         ON CONFLICT(number) DO UPDATE SET uid = excluded.uid`,
      );
      link.run(String(num), uid);
      link.run(String(cid), uid);
      return this._account(uid);
    });
  }

  // ---- friends ----
  // Look an account up by phone number. The client is inconsistent about formats: the
  // same person is `9917886095` (as registered), `+19917886095` (search with a +1 country
  // picker), `79917886095` or `89917886095` (Russian trunk prefix). So: exact match first,
  // then compare digits as a suffix (one number ends with the other, >= 7 digits shared),
  // preferring the longest shared suffix. Fine for a LAN-sized account table.
  findByNumber(number) {
    if (number == null) return null;
    const raw = String(number).trim();
    const exact = this._uidByNumber(raw.replace(/^\+/, '')) || this._uidByNumber(raw);
    if (exact) return this._account(exact);

    const digits = raw.replace(/\D/g, '');
    if (digits.length < 7) return null;
    let best = null;
    let bestLen = 0;
    for (const row of this.db.prepare('SELECT number, uid FROM account_numbers').all()) {
      const n = String(row.number).replace(/\D/g, '');
      if (n.length < 7) continue;
      const short = n.length <= digits.length ? n : digits;
      const long = n.length <= digits.length ? digits : n;
      if (long.endsWith(short) && short.length > bestLen) {
        best = row.uid;
        bestLen = short.length;
      }
    }
    return best ? this._account(best) : null;
  }
  addFriend(uid, buddyNumber) {
    this.db
      .prepare('INSERT OR IGNORE INTO friends(uid, number, added_at) VALUES (?,?,?)')
      .run(uid, String(buddyNumber).replace(/^\+/, ''), Date.now());
  }
  getFriends(uid) {
    return this.db
      .prepare('SELECT number FROM friends WHERE uid = ? ORDER BY added_at, number')
      .all(uid)
      .map((r) => r.number);
  }

  // ---- SMS auth ----
  issueToken(phone) {
    const token = genToken();
    this.db
      .prepare('INSERT INTO sms_tokens(token, phone, authnum, created_at) VALUES (?,?,NULL,?)')
      .run(token, nz(phone), Date.now());
    return token;
  }
  // "Send" the SMS: generate the auth number and hand it back so the caller can
  // print it to the console (no real SMS gateway).
  sendSms(token, phone) {
    const authnum = genAuthNum();
    this.db
      .prepare(
        `INSERT INTO sms_tokens(token, phone, authnum, created_at) VALUES (?,?,?,?)
         ON CONFLICT(token) DO UPDATE SET authnum = excluded.authnum,
           phone = COALESCE(excluded.phone, sms_tokens.phone)`,
      )
      .run(nz(token), nz(phone), authnum, Date.now());
    return authnum;
  }
  // Verify is intentionally lenient for a local emulator: accept the stored
  // authnum, or any authnum if none was tracked.
  verify(token, authnum) {
    if (token == null) return true;
    const rec = this.db.prepare('SELECT authnum FROM sms_tokens WHERE token = ?').get(token);
    if (!rec || rec.authnum == null) return true;
    return String(rec.authnum) === String(authnum);
  }

  // ---- message history ----
  logMessage({ sender, uid, text }) {
    this.db
      .prepare('INSERT INTO messages(sender, recipient_uid, text, ts) VALUES (?,?,?,?)')
      .run(nz(sender), nz(uid), nz(text), Date.now());
  }
  recentMessages(limit = 20) {
    return this.db
      .prepare('SELECT id, sender, recipient_uid, text, ts FROM messages ORDER BY id DESC LIMIT ?')
      .all(limit)
      .reverse()
      .map((r) => ({ ...r }));
  }
}

module.exports = { Store };
