#!/usr/bin/env bash
# Generates (or reuses) a private CA, then a server cert valid for both the GLD
# (REST) and push hostnames PLUS any extra IPs/hosts you deploy on, and a BKS
# keystore (spp916.bks replacement) that trusts the CA.
#
# The CA is REUSED if ca.crt/ca.key already exist, so re-running to add a new IP
# does NOT invalidate the CA already installed on your device — only the server
# cert changes. Requires: openssl, keytool, bcprov.jar (for the BKS step).
#
# Add your server's LAN IP(s) so TLS-by-IP works (the provisioning reply
# advertises the server by IP):
#   LS_IP=192.168.0.20 ./gen-certs.sh
#   LS_IP=192.168.0.20,10.0.0.5 LS_HOST=chaton.lan ./gen-certs.sh
set -euo pipefail
BCPROV="${BCPROV:-../bcprov.jar}"
STOREPASS="sppkeystore"     # must match SecurityUtil.java
DAYS=3650
LS_IP="${LS_IP:-}"          # comma-separated extra IP SANs
LS_HOST="${LS_HOST:-}"      # comma-separated extra DNS SANs

if [[ -f ca.key && -f ca.crt ]]; then
  echo "[*] Reusing existing CA (ca.crt/ca.key) — device trust stays valid"
else
  echo "[*] Creating new CA"
  openssl genrsa -out ca.key 2048 2>/dev/null
  openssl req -x509 -new -nodes -key ca.key -sha256 -days $DAYS -out ca.crt \
    -subj "/C=KR/O=Lightswitch/CN=Lightswitch Local CA" 2>/dev/null
fi

echo "[*] Server key + CSR"
openssl genrsa -out server.key 2048 2>/dev/null
openssl req -new -key server.key -out server.csr \
  -subj "/C=KR/O=Lightswitch/CN=*.push.samsungosp.com" 2>/dev/null

echo "[*] Building SAN list"
{
  echo "basicConstraints=CA:FALSE"
  echo "keyUsage=digitalSignature,keyEncipherment"
  echo "extendedKeyUsage=serverAuth"
  echo "subjectAltName=@alt"
  echo "[alt]"
  echo "DNS.1=*.push.samsungosp.com"
  echo "DNS.2=push.samsungosp.com"
  echo "DNS.3=gld1.samsungchaton.com"
  echo "DNS.4=gld2.samsungchaton.com"
  echo "DNS.5=*.samsungchaton.com"
  n=6
  IFS=',' read -ra HOSTS <<< "$LS_HOST"
  for h in "${HOSTS[@]}"; do [[ -n "$h" ]] && echo "DNS.$n=$h" && n=$((n+1)); done
  echo "IP.1=127.0.0.1"
  i=2
  IFS=',' read -ra IPS <<< "$LS_IP"
  for ip in "${IPS[@]}"; do [[ -n "$ip" ]] && echo "IP.$i=$ip" && i=$((i+1)); done
} > server.ext

echo "[*] Signing server cert"
openssl x509 -req -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial \
  -out server.crt -days $DAYS -sha256 -extfile server.ext 2>/dev/null

echo "[*] Building spp916.bks (trusts our CA)"
rm -f spp916.bks
for alias in cacert pushservertrust; do
  keytool -importcert -noprompt -alias "$alias" -file ca.crt \
    -keystore spp916.bks -storetype BKS -storepass "$STOREPASS" \
    -providerpath "$BCPROV" -provider org.bouncycastle.jce.provider.BouncyCastleProvider 2>/dev/null
done

cat server.key server.crt > server.pem
echo "[+] Done. SANs:"
openssl x509 -in server.crt -noout -text | grep -A1 "Subject Alternative Name" | tail -1 | sed 's/^ */    /'
