# lightswitch
A server for Samsung's old chat service, ChatON.

**A private, self-hostable server emulator for Samsung ChatON** — bringing a
messenger that Samsung shut down in 2016 back to life on your own LAN.
 
Lightswitch speaks the original ChatON protocol, reverse-engineered from the
`com.sec.chaton` **1.10.3** (2012) Android client. Point an old ChatON build at
it and the app provisions, registers, logs in, and reaches its main UI — no
Samsung servers involved.
 
> Part of an ongoing effort to keep dead mobile services runnable for
> preservation and study. It is not affiliated with or endorsed by Samsung.
 
---
 
## Status
 
| Area | State |
|------|-------|
| GLD provisioning (`/prov`, `/prov3`) | ✅ working |
| Registration — skip-SMS (`/auth/join`) | ✅ working |
| Registration — SMS flow (`/sms/*`, `/v2/reg`) | ✅ working (code printed to console) |
| Push channel: provisioning + Init/Registration/Ping | ✅ working |
| Login → main UI on a real device | ✅ verified |
| Buddies: add / preview / list | ✅ working |
| Messaging between accounts | 🚧 next |
| Profile / media (avatars, images) | ⛔ not yet |
 
Everything above is exercised by an end-to-end self-test (`npm test`).
 
<!-- Add a screenshot at docs/screenshot.png -->
<!-- ![ChatON running against Lightswitch](docs/screenshot.png) -->
 
---
 
## How it works
 
ChatON uses **two independent channels**, and Lightswitch serves both:
 
### 1. REST over HTTPS (GLD / contact / SMS / file)
 
The client first hits a **GLD** (global directory) endpoint for provisioning,
which returns the addresses of the real service nodes, one per role:
 
```
GET /prov3  →  { expdate, primary:[Server], secondary:[Server] }
              Server = { address, name, port, region }
              name ∈ { contact, message, file, sms }
```
 
`contact` carries the REST API (registration, buddies, profile, inbox), `sms`
the SMS gateway, `file` media. Request bodies are **XML** (`<param>…</param>`);
responses are consumed as **JSON**. The client chooses `http` vs `https` per role
purely by the advertised port (`443 → https`, otherwise `http`).
 
### 2. Push channel — Protobuf over TLS
 
A separate persistent socket delivers notifications and messages. It is **not
HTTP** — it is length-prefixed Google Protobuf:
 
```
┌─────────┬──────┬───────────────┬───────────────────────┐
│ 1 byte  │ 1 b  │ 2 bytes (BE)  │ N bytes               │
│ reserved│ type │ body length   │ protobuf MessageLite  │
└─────────┴──────┴───────────────┴───────────────────────┘
```
 
The push socket does its **own** provisioning first (`ProvisionRequest` →
`ProvisionReply`) to learn the message-server address, then runs the handshake.
Message types:
 
| id | message | id | message |
|----|---------|----|---------|
| 0 | InitRequest | 7 | PingReply |
| 1 | InitReply | 8 | NotiElement |
| 2 | RegistrationRequest | 9 | NotiGroup |
| 3 | RegistrationReply | 10 | NotiAcks |
| 4 | DeregistrationRequest | 11 | ProvisionRequest |
| 5 | DeregistrationReply | 12 | ProvisionReply |
| 6 | PingRequest | | |
 
Handshake: `ProvisionRequest → ProvisionReply` (learn message server) →
`InitRequest → InitReply` (result `1000`, async id echoed) →
`RegistrationRequest → RegistrationReply` → `Ping ↔ PingReply` heartbeats.
Notifications arrive as `NotiGroup`/`NotiElement`; the client acks with
`NotiAcks`. The reconstructed schema lives in
[`server/proto/chaton_push.proto`](server/proto/chaton_push.proto), each field
annotated to the exact wire call it came from.
 
---
 
## Requirements
 
- **Node.js ≥ 18** (server)
- A ChatON **1.10.3** APK — *bring your own*; Lightswitch does not distribute it
- For on-device use: a way to override DNS on your test device (a local resolver
  such as dnsmasq, or a rooted `/etc/hosts`)
- Optional, to rebuild the TLS-off client patch: `apktool`, `openssl`, `keytool`
  (BouncyCastle for the BKS step), and an APK signer
---
 
## Quick start
 
```bash
cd server
npm install
npm test                       # end-to-end self-test, no device needed
LS_PUBLIC_HOST=192.168.0.20 sudo -E npm start
```
 
`sudo` is only needed because the REST server defaults to ports 443/80; override
with env vars to avoid it. Always set `LS_PUBLIC_HOST` to the IP your **device**
can reach — it is advertised to the client during provisioning.
 
Registering with the SMS flow? There is no real SMS gateway, so the auth code is
printed to the server console:
 
```
=========================================
  SMS auth code for 79917886095: 8251
=========================================
```
 
Type it into the app.
 
### Configuration
 
| Variable | Default | Purpose |
|----------|---------|---------|
| `LS_PUBLIC_HOST` | `127.0.0.1` | IP advertised to the device (set this!) |
| `LS_BIND_HOST` | `0.0.0.0` | interface to bind |
| `LS_PUSH_TLS` | `1` | `0` = plaintext push (needs the SSL-off patch) |
| `LS_REST_TLS` | `1` | `0` = advertise REST roles over HTTP |
| `LS_GLD_PORT` | `443` | REST HTTPS port |
| `LS_GLD_HTTP_PORT` | `80` | REST HTTP port |
| `LS_PUSH_PORT` | `5223` | push channel port |
| `LS_PROV_TTL_MS` | `86400000` | provisioning validity |
 
---
 
## Connecting a real device
 
Two things: point the ChatON hostnames at your server, and get past the client's
TLS.
 
**1. DNS override.** Redirect these to your server's IP:
`gld1.samsungchaton.com`, `gld2.samsungchaton.com`, and
`gld.push.samsungosp.com` (the push directory). Other nodes are advertised by IP
in the provisioning reply, so they need no DNS entry.
 
**2. TLS.** There are two TLS layers, removed independently:
 
- **Push** pins its CA via a bundled keystore, so the cleanest route is to
  disable it: flip one instruction in each of `push/b/a/c.smali` and
  `d.smali` (`const/4 v2, 0x1` → `0x0`), rebuild, sign, and run the server with
  `LS_PUSH_TLS=0`. See [`certs/`](certs) and the details in
  [`server/README.md`](server/README.md).
- **REST** picks its scheme by port, so `LS_REST_TLS=0` makes contact/sms/file
  plaintext with no code change. The single hardcoded `https://gld1…`
  provisioning call still needs either your own CA installed on the device (easy
  on the old Android this targets) or a one-string smali patch.
For a fully plaintext, cert-free setup:
 
```bash
LS_PUSH_TLS=0 LS_REST_TLS=0 LS_PUBLIC_HOST=192.168.0.20 sudo -E npm start
```
 
If you'd rather keep TLS, `certs/gen-certs.sh` builds a private CA, a server cert
(pass `LS_IP=<your-ip>` so TLS-by-IP works), and a drop-in `spp916.bks`
replacement for the APK.
 
---
 
## Repository layout
 
```
server/
  proto/chaton_push.proto   reconstructed push protobuf schema
  src/
    proto.js         push frame codec + type registry
    push-server.js   TLS/plaintext push server: handshake, provisioning, noti
    gld-server.js    HTTPS+HTTP REST: provisioning, registration, buddies, …
    store.js         in-memory accounts / devices / friends / message queues
    config.js, log.js
  index.js           starts both servers
  test/selftest.js   end-to-end self-test (a fake client drives the full flow)
  README.md          developer notes and protocol deep-dive
certs/
  gen-certs.sh       CA + server cert + spp916.bks generator
```
 
---
 
## Roadmap
 
- **Messaging between two accounts** — chat runs over the push channel:
  `NotiGroup`/`NotiElement` inbound, `NotiAcks` outbound. Sender's `NotiElement`
  gets routed to the recipient's device queue.
- **Own profile / "My page"** and buddy self-record
- **File/media server** — avatars and image messages
- **Persistence** — swap the in-memory store for SQLite
---
 
## Legal
 
Lightswitch is an independent, clean-room-style reimplementation of a **defunct**
service's protocol, created for preservation, interoperability, and study. It
ships **no** Samsung code or assets — you supply your own client APK. "ChatON"
and "Samsung" are trademarks of Samsung Electronics; this project is not
affiliated with, authorized, or endorsed by them. Use it only with software you
are lawfully entitled to run, and on your own infrastructure.

