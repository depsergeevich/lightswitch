# Lightswitch — private ChatON server emulator

A private, offline server emulator for **Samsung ChatON** (`com.sec.chaton`,
client **1.10.3**, build 2012). The protocol was reverse-engineered directly
from the (unobfuscated) decompiled APK. This repo revives enough of the service
to bring a real client up to and through its push handshake on a LAN.

Status: **a real client registers, logs in, reaches the main UI, and can add
friends** — two registered accounts find each other by number and appear in each
other's buddy list. Messaging (push `NotiElement`) is the next phase. `npm test`
covers the whole path (provisioning, registration, push handshake + provisioning,
gzip bodies, buddy add/list).

## Architecture (as traced)

ChatON has two independent channels:

1. **GLD / REST over HTTPS** — entry point `https://gld1.samsungchaton.com`.
   - `GLDControl.java` → `GET /prov?imei&msisdn&imsi&model&clientversion&platform&osversion`.
   - Response is JSON parsed reflectively (`util/o.java`) into `GetSSMServerAddress`:
     `{ expdate, primary:[Server], secondary:[Server] }`,
     `Server = { address, name, port, region }`. Each list holds one entry per
     **role**, keyed by `Server.name` (`d/a/ai.java`, `ah.java`):
     `contact` (REST API), `message` (push channel), `file` (media), and — for
     `/prov3` — `sms` (SMS gateway). Port `443` on a role means the client talks
     `https://` to it (`ba.l()`), any other port means `http://`.
   - `ServerAddressMgr` (`util/ba.java`) stores each role's address/port and
     re-provisions when `expdate` passes.
   - **Registration (CONTACT), all JSON POST bodies (`util/o.java` serializer):**
     - `POST /auth/join {imei,pushtype:"SPP",osversion,imsi,model,name}`
       → `{chatonid, uid}` — skip-SMS path, the quickest route to a usable
       account (`d/a/ce.java`).
     - SMS path: `GET /sms/v2/authtoken` → `{token}`; `GET /sms/v3/send` sends the
       code; `POST /v2/reg/smsv {msisdn,token,authnum}` verifies; then
       `POST /v2/reg {msisdn,imei,name,token,authnum,...}` → `{uid}`
       (`d/a/by.java`, `ck.java`, `d/am.java`). The emulator has no SMS gateway,
       so the auth code is **printed to the server console** to type into the app.
   - Further REST still to trace: `/v3/buddy`, `/profile/…`, `/inbox…`. REST TLS
     uses the **system trust store** (`i/c.java` → default `SSLSocketFactory`).

2. **Push channel over TLS** — the primary/secondary address from provisioning.
   Netty pipeline (`push/b/b/i.java`): `[ssl] → decoder(e) → encoder(h) → handler(c)`.
   - **Frame** (`MessageDecoder`/`MessageEncoder`):
     ```
     [1 byte reserved=0][1 byte type][2 bytes length BE][protobuf body]
     ```
   - Body is Google Protobuf; `type ↔ class` registry is `com.sec.a.a.a.ap`
     (`MsgFrontendCommon`). Message types:

     | type | message | type | message |
     |------|---------|------|---------|
     | 0 | InitRequest | 7 | PingReply |
     | 1 | InitReply | 8 | NotiElement |
     | 2 | RegistrationRequest | 9 | NotiGroup |
     | 3 | RegistrationReply | 10 | NotiAcks |
     | 4 | DeregistrationRequest | 11 | ProvisionRequest |
     | 5 | DeregistrationReply | 12 | ProvisionReply |
     | 6 | PingRequest | | |

   - Handshake: `InitRequest → InitReply` (must echo `async_id`, `result=1000`),
     `RegistrationRequest → RegistrationReply` (`result=1000`), `Ping ↔ PingReply`
     heartbeats, server pushes `NotiGroup`/`NotiElement`, client replies `NotiAcks`.
   - Success/error codes (`push/c/a/b.java`, `h.java`): **1000 = OK**; 4002/4006
     → disconnect + re-provision.

The reconstructed schema is in [`proto/chaton_push.proto`](proto/chaton_push.proto),
with each field annotated to the exact `writeTo` call it came from.

## Layout

```
server/
  proto/chaton_push.proto   reconstructed push protobuf schema
  src/
    proto.js         .proto loader + type registry + frame codec
    push-server.js   TLS push server: Init/Registration/Ping/Noti + delivery
    gld-server.js    HTTPS: provisioning + registration/SMS + catch-all logger
    store.js         in-memory devices/queues (swap for node:sqlite later)
    config.js        ports, public host, cert paths
    log.js
  index.js           starts both servers; stdin `notify <regId> <text>`
  test/selftest.js   fake client: TLS + full handshake + noti round-trip
certs/
  gen-certs.sh       regenerate CA + server cert + spp916.bks
  ca.crt ca.key      the private CA (install ca.crt on the device)
  server.crt/key/pem server cert (SANs cover both hostnames)
  spp916.bks         APK resource replacement (trusts our CA)
```

## Running

```
cd server
npm install
npm test                    # end-to-end self-test, no device needed
LS_PUBLIC_HOST=192.168.0.20 sudo -E npm start
```

`sudo` only because the GLD port defaults to 443. Override ports with
`LS_GLD_PORT` / `LS_PUSH_PORT`, and always set `LS_PUBLIC_HOST` to the IP the
**device** can reach (advertised in the provisioning reply).

Env vars: `LS_PUSH_TLS` (0), `LS_REST_TLS` (0), `LS_GLD_PORT` (443),
`LS_GLD_HTTP_PORT` (80), `LS_PUSH_PORT` (5223), `LS_PUBLIC_HOST` (192.168.0.20),
`LS_BIND_HOST` (0.0.0.0), `LS_CERT_DIR`, `LS_PROV_TTL_MS`. For a fully plaintext
setup use the included patched APK with `LS_PUSH_TLS=0 LS_REST_TLS=0`.

## Pointing a real device at this server

Two channels, two trust stores, so redirection has two halves. One private CA
covers both (already generated in `certs/`).

**1. DNS override** — make the device resolve the ChatON hosts to your server:
`gld1.samsungchaton.com`, `gld2.samsungchaton.com`, and the push host advertised
in `/prov` (use your own IP, so no DNS entry needed for push). A local DNS
server (dnsmasq) or a rooted `/etc/hosts` works.

**2. REST/GLD trust** — the REST client uses the **system** trust store. On the
old Android this client targets (minSdk 8 / target 14), user-installed CAs are
trusted system-wide, so just install `certs/ca.crt` as a user credential
(Settings → Security → Install from storage). No APK change needed for REST.

**3. Push trust** — the push socket **pins** its CA via the bundled keystore
`res/raw/spp916.bks` (it holds only trusted certs — `*.push.samsungosp.com` — no
client key, so it's plain server-cert pinning, not mutual TLS). To make the
client trust our push server, **replace that keystore** and re-sign the APK:

```
# spp916.bks in certs/ already trusts our CA (storepass "sppkeystore")
apktool d chaton.apk -o chaton_src
cp certs/spp916.bks chaton_src/res/raw/spp916.bks
apktool b chaton_src -o chaton_patched.apk
# then zipalign + sign with your key
```

### Removing TLS entirely (recommended for tracing)

Because the push channel pins its CA, the cert dance is the annoying part. It's
avoidable — plaintext also makes the remaining protocol trivially readable in
PCAPdroid/Wireshark, which is worth a lot while tracing.

There are two TLS layers, removed differently:

- **Push TLS** is hardcoded `true` at two call sites (`new i(ctx,true)` /
  `new j(ctx,true)` in `push/b/a/c.java` & `d.java`) — no flag disables it, so it
  needs a one-instruction smali flip at each:
  ```
  # smali/com/sec/chaton/push/b/a/c.smali  (before invoke-direct ... b/b/i;-><init>)
  # smali/com/sec/chaton/push/b/a/d.smali  (before invoke-direct ... b/b/j;-><init>)
  -    const/4 v2, 0x1
  +    const/4 v2, 0x0
  ```
  Then run the server with `LS_PUSH_TLS=0` — plaintext TCP push, and
  `spp916.bks` is no longer needed at all.

- **REST TLS** needs no code patch: the client picks `http` vs `https` purely
  from the advertised role port (`ba.l()`: `443 → https`, else `http`). Run the
  server with `LS_REST_TLS=0` and it advertises contact/file/sms on the HTTP
  port, so the client talks plaintext to them. The one exception is the *first*
  call — `https://gld1.samsungchaton.com` is hardcoded (`c/b.java`,
  `const-string "https://gld1.samsungchaton.com"` at `c/b.smali`). Either keep
  that one call on HTTPS (the server always also listens on 443; install
  `ca.crt` as a user cert — trivial on the old Android this targets), or patch
  that string to `http://…` for zero certs anywhere.

**The included `chaton_nossl.apk` already has the push SSL-off patch applied and
is signed** (debug key). With it, `LS_PUSH_TLS=0`, and a DNS override, no
keystore or CA is involved for push.

To rebuild the patch yourself:
```
java -jar apktool.jar d -r -f -o out chaton.apk
# flip the two const/4 v2, 0x1 -> 0x0 as above
java -jar apktool.jar b out -o chaton_nossl_unsigned.apk
java -jar uber-apk-signer.jar --apks chaton_nossl_unsigned.apk --allowResign
```

### Keeping TLS (keystore replacement)

If you'd rather keep push TLS, replace the pinned keystore instead of patching
code. `certs/spp916.bks` already trusts our CA (storepass `sppkeystore`):

```
apktool d chaton.apk -o chaton_src
cp certs/spp916.bks chaton_src/res/raw/spp916.bks
apktool b chaton_src -o chaton_patched.apk   # then sign
```

> Regenerate certs any time with `certs/gen-certs.sh` (needs `bcprov.jar` for the
> BKS step). **Advertising the server by IP requires that IP in the cert SAN**,
> or the client's HTTPS calls to contact/sms/file fail TLS host verification
> (symptom: provisioning to `gld1` works, then an on-screen error and no
> `/sms/*` in the log). Pass it in — the CA is reused, so the device's installed
> CA stays valid and only the server cert changes:
> ```
> LS_IP=192.168.0.20 ./gen-certs.sh   # then restart the server
> ```
> (Or sidestep certs on these calls entirely with `LS_REST_TLS=0` — plaintext
> REST — pairing naturally with the SSL-off APK.)

## Persistence (SQLite)

State is kept in a single SQLite file (default `server/data/lightswitch.db`, WAL mode;
override with `LS_DB=/path/to.db`, or `LS_DB=:memory:` for a throwaway run). It uses
Node's built-in `node:sqlite`, so **Node >= 22.13** is required and nothing native has
to be compiled (Node may print an `ExperimentalWarning` — harmless).

| Table | Holds |
|-------|-------|
| `accounts`, `account_numbers` | registered users and every number/id that resolves to them |
| `friends` | friendships (de-duplicated) |
| `sms_tokens` | SMS auth tokens + codes (purged after 24 h) |
| `ip_bindings` | device IP -> account, used to route push messages |
| `queue` | undelivered push notifications, per account — delivered when the device connects, deleted on `NotiAcks` |
| `messages` | history of everything routed through the server |

- Schema version is tracked in `PRAGMA user_version`; a DB from a *newer* server is
  refused instead of being corrupted.
- Console: `accounts`, `history [n]` (last n routed messages), `say <number> <text>`.
- Back up by copying the `.db` file (plus `-wal`/`-shm` if the server is running), or
  inspect it with the `sqlite3` CLI: `sqlite3 server/data/lightswitch.db 'select * from accounts'`.
- To reset everything, stop the server and delete `server/data/`.
- Runtime-only (not stored): which push sessions are connected right now.

## Pitfalls learned from real-client logs

Every item below was found by running a real ChatON 1.10.3 and reading the server log,
and each one is pinned by a regression test in `test/selftest.js` (several decode raw
bytes captured from a real client, *independently* of our own `.proto`):

- **Push replies: field 1 = async id, field 2 = result.** The client reads `InitReply`/
  `RegistrationReply` with `d()` = field 1 (must equal its request id) and `f()` = field 2
  (1000 = OK). With the two swapped the client silently drops the reply, closes the socket
  after a few ms and retries forever — it never even sends `RegistrationRequest`.
  (Symptom in the log: every push connection lives ~5 ms, `say` reports `0 live session(s)`.)
- **`GET /v3/buddies` is always `mode=blocked`.** That is the client's normal full buddy-list
  sync, not a request for blocked users — never answer it with an empty list.
- **Address bodies are `<address name="Bob">+7999…</address>`** (the number is the element
  text, the name an attribute) — not a nested `<value>` tag.
- **Phone numbers arrive in whatever shape the country picker produced** (`+19917886095`,
  `79917886095`, `89917886095` for an account registered as `9917886095`), so lookup matches by
  digit suffix (>= 7 digits) after trying an exact match.
- **`POST /address` is a phone-book upload.** Contacts who are registered show up as friends
  automatically (as in the original service). The server keeps only the resulting
  friendships and **never prints or stores the contact list**.

## Debugging against a live device

- `LS_DEBUG=1` hex-dumps every raw byte chunk received on the push socket, so an
  unmodelled frame (e.g. the client's outbound chat message) can be decoded by hand.
  Frames with an unknown type id are logged with `raw=<hex>` as well.
- REST request bodies that are binary (e.g. `POST /notification`) are logged as
  `body(binary NB hex)=…` instead of garbled text; gzip bodies are decompressed first.
- Operator console (type into the server's stdin):
  - `accounts` — list registered accounts
  - `say <number> <text>` — send a message to a registered account from the server;
    quickest way to check inbound delivery on a real phone
  - `notify <pushRegId> <text>` — low-level push to one push registration id
- **Account <-> push session binding is by device IP.** Push frames carry no `uid`,
  but REST calls do and come from the same device, so the server remembers
  `ip -> uid`. Fine on a LAN; two devices behind one NAT IP would collide.
- **Delivered NotiElement fields** (verified against the client's receive path,
  `push/c/a/d.java`): field 5 = sender, field 6 = message text, field 13 = session
  info, field 11 = timestamp, field 1 = notification id (what `NotiAcks` echoes).

> Outbound chat (client -> server) is still **unverified on hardware**: the router in
> `index.js` is experimental and only resolves a recipient from phone-number-like
> tokens in `app_data`/`session_info`. Capture one real send with `LS_DEBUG=1` to pin
> the true format.

## Next steps

- **Messaging between two accounts** (the headline feature). Buddy add/list is
  done; the remaining piece is chat itself, which runs over the **push channel**
  (not REST): the receiver path is `NotiGroup`→`NotiGroupMessageTask`→broadcast
  to `ChatBackgroundService`; the client acks with `NotiAcks`. To implement send:
  capture one real message on the wire to pin the `NotiElement` content encoding
  (which field carries the text, the sender, and the chat session id — the
  getters `r.d/f/h/j/l/n/p/r/t/v` map to fields 1-13), then route an inbound
  `NotiElement` from the sender to the recipient's device queue (the push server
  already delivers `NotiGroup` + drains on `NotiAcks`).
- **Own profile / "My page"**: `/profile/…` so the profile screen shows the
  registered name/avatar.
- **File/media server** (avatars, image messages) — the `file` provisioning role.
```
