'use strict';

// Push wire codec for ChatON.
//
// Frame (see push/b/b/e.java = MessageDecoder, h.java = MessageEncoder):
//   [1 byte reserved = 0][1 byte type][2 bytes length BE][length bytes protobuf body]
//
// `type` <-> message class mapping is `com.sec.a.a.a.ap` (MsgFrontendCommon).

const path = require('path');
const protobuf = require('protobufjs');

const PROTO_PATH = path.join(__dirname, '..', 'proto', 'chaton_push.proto');

// type byte -> proto message name (from ap.a(byte))
const TYPE_TO_NAME = {
  0: 'InitRequest',
  1: 'InitReply',
  2: 'RegistrationRequest',
  3: 'RegistrationReply',
  4: 'DeregistrationRequest',
  5: 'DeregistrationReply',
  6: 'PingRequest',
  7: 'PingReply',
  8: 'NotiElement',
  9: 'NotiGroup',
  10: 'NotiAcks',
  11: 'ProvisionRequest',
  12: 'ProvisionReply',
};
const NAME_TO_TYPE = Object.fromEntries(
  Object.entries(TYPE_TO_NAME).map(([k, v]) => [v, Number(k)]),
);

let root = null;
const cache = new Map();

function load() {
  if (!root) {
    // keepCase: true keeps snake_case field names (async_id, push_reg_id, ...)
    // instead of protobufjs's default camelCase, so server code and the schema
    // use one spelling.
    const fs = require('fs');
    const parsed = protobuf.parse(fs.readFileSync(PROTO_PATH, 'utf8'), { keepCase: true });
    root = parsed.root;
  }
  return root;
}

function messageType(name) {
  if (!cache.has(name)) {
    cache.set(name, load().lookupType(`chaton.push.${name}`));
  }
  return cache.get(name);
}

// Encode a { name, body } into a full framed buffer ready for the socket.
function encodeFrame(name, body) {
  const type = NAME_TO_TYPE[name];
  if (type === undefined) throw new Error(`unknown push message: ${name}`);
  const T = messageType(name);
  const err = T.verify(body);
  if (err) throw new Error(`invalid ${name}: ${err}`);
  const payload = T.encode(T.fromObject(body)).finish();
  if (payload.length > 0xffff) throw new Error(`${name} body too large`);
  const frame = Buffer.allocUnsafe(4 + payload.length);
  frame.writeUInt8(0, 0); // reserved
  frame.writeUInt8(type, 1); // type
  frame.writeUInt16BE(payload.length, 2); // length (BE short)
  Buffer.from(payload).copy(frame, 4);
  return frame;
}

// Pull as many complete frames as are buffered. Returns { messages, rest }.
// messages: [{ type, name, body }]
function decodeFrames(buf) {
  const messages = [];
  let off = 0;
  while (buf.length - off >= 4) {
    const type = buf.readUInt8(off + 1);
    const len = buf.readUInt16BE(off + 2);
    if (buf.length - off - 4 < len) break; // incomplete body
    const bodyBuf = buf.subarray(off + 4, off + 4 + len);
    const name = TYPE_TO_NAME[type];
    let body = null;
    if (name) {
      try {
        body = messageType(name).toObject(messageType(name).decode(bodyBuf), {
          longs: Number, // timestamps/ids fit in 2^53; keeps values re-encodable
          bytes: Buffer,
          defaults: true,
        });
      } catch (e) {
        body = { _decodeError: e.message, _raw: Buffer.from(bodyBuf) };
      }
    } else {
      body = { _raw: Buffer.from(bodyBuf) };
    }
    messages.push({ type, name: name || `unknown(${type})`, body });
    off += 4 + len;
  }
  return { messages, rest: buf.subarray(off) };
}

// small helpers: our proto declares text-ish fields as `bytes`
const b = (s) => (s == null ? undefined : Buffer.from(String(s), 'utf8'));
const s = (buf) => (buf == null ? undefined : Buffer.from(buf).toString('utf8'));

module.exports = {
  load,
  messageType,
  encodeFrame,
  decodeFrames,
  TYPE_TO_NAME,
  NAME_TO_TYPE,
  b,
  s,
};
