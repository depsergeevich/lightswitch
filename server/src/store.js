'use strict';

// Deliberately permissive in-memory store for a private/offline emulator of a
// dead service. Swap for node:sqlite (Node >=22.5) when persistence is wanted —
// same shape as the other Lightswitch/friendaround servers.

const crypto = require('crypto');

let deviceSeq = 1;
let uidSeq = 100000;

function genUid() {
  // ChatON uids are opaque strings; any stable unique token works.
  return `U${uidSeq++}`;
}
function genAuthNum() {
  return String(Math.floor(1000 + Math.random() * 9000)); // 4-digit (client input field)
}
function genToken() {
  return crypto.randomBytes(16).toString('hex');
}

class Store {
  constructor() {
    this.devices = new Map(); // pushRegId -> { pushRegId, msisdn, connected, queue: [NotiElement] }
    this.accounts = new Map(); // uid -> { uid, msisdn, chatonid, name, imei }
    this.byMsisdn = new Map(); // msisdn/chatonid -> uid
    this.smsTokens = new Map(); // token -> { phone, authnum }
    this.friends = new Map(); // uid -> Set<buddyNumber>
  }

  // ---- push devices ----
  device(pushRegId) {
    let d = this.devices.get(pushRegId);
    if (!d) {
      d = { pushRegId, msisdn: null, connected: false, queue: [] };
      this.devices.set(pushRegId, d);
    }
    return d;
  }

  enqueue(pushRegId, element) {
    const d = this.device(pushRegId);
    const el = { seq: deviceSeq++, ...element };
    d.queue.push(el);
    return el;
  }
  drain(pushRegId) {
    return this.device(pushRegId).queue.slice();
  }
  ack(pushRegId, ids) {
    const d = this.device(pushRegId);
    const set = new Set(ids.map(String));
    d.queue = d.queue.filter((e) => !set.has(String(e.noti_id)) && !set.has(String(e.seq)));
  }

  // ---- accounts / registration ----
  // Register (or re-register) an account. `chatonid` defaults to msisdn; for the
  // skip-SMS path there may be no phone number, so a chatonid is minted.
  register({ msisdn, name, imei, chatonid }) {
    let uid = msisdn ? this.byMsisdn.get(msisdn) : null;
    if (!uid) uid = genUid();
    const cid = chatonid || msisdn || `local-${uid}`;
    const acct = { uid, msisdn: msisdn || cid, chatonid: cid, name: name || cid, imei: imei || null };
    this.accounts.set(uid, acct);
    if (acct.msisdn) this.byMsisdn.set(acct.msisdn, uid);
    if (cid) this.byMsisdn.set(cid, uid);
    return acct;
  }

  // ---- friends ----
  findByNumber(number) {
    if (number == null) return null;
    const n = String(number).replace(/^\+/, '');
    const uid = this.byMsisdn.get(n) || this.byMsisdn.get('+' + n);
    return uid ? this.accounts.get(uid) : null;
  }
  addFriend(uid, buddyNumber) {
    if (!this.friends.has(uid)) this.friends.set(uid, new Set());
    this.friends.get(uid).add(String(buddyNumber).replace(/^\+/, ''));
  }
  getFriends(uid) {
    return [...(this.friends.get(uid) || [])];
  }

  // ---- SMS auth ----
  issueToken(phone) {
    const token = genToken();
    this.smsTokens.set(token, { phone, authnum: null });
    return token;
  }
  // "Send" the SMS: generate the auth number and hand it back so the caller can
  // print it to the console (no real SMS gateway).
  sendSms(token, phone) {
    let rec = this.smsTokens.get(token);
    if (!rec) {
      rec = { phone, authnum: null };
      this.smsTokens.set(token, rec);
    }
    rec.phone = phone || rec.phone;
    rec.authnum = genAuthNum();
    return rec.authnum;
  }
  // Verify is intentionally lenient for a local emulator: accept the stored
  // authnum, or any authnum if none was tracked.
  verify(token, authnum) {
    const rec = this.smsTokens.get(token);
    if (!rec || rec.authnum == null) return true;
    return String(rec.authnum) === String(authnum);
  }
}

module.exports = { Store };
