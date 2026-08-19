#!/usr/bin/env bash
# 04-generate-admin-cert.sh (OPTIONAL) - a browser client certificate for the
# initial NiFi admin, signed by the same CA.
#
# Identity = the subject DN (no SAN needed for client certs). Import
# out/clients/admin/admin.p12 into the browser (password = TLS_ADMIN_PASS) and
# set INITIAL_ADMIN_IDENTITY to exactly "CN=admin, OU=NIFI" (RFC1779: comma +
# space) when enabling TLS - see README.md.
#
# Local-only artifact: hand-delivered to the admin, never uploaded to S3.
set -Eeuo pipefail

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
. "$script_dir/00-env.sh"

require_jdk 21
prompt_secret TLS_CA_PASS 'CA keystore password'
prompt_secret TLS_ADMIN_PASS 'Admin client keystore password'

if [[ ! -f "$OUT_DIR/ca/ca.p12" || ! -f "$OUT_DIR/ca/ca.pem" ]]; then
  echo "error: CA not found under $OUT_DIR/ca - run 01-generate-ca.sh first" >&2
  exit 1
fi

fresh_target "$OUT_DIR/clients/admin"
mkdir -p -- "$OUT_DIR/clients/admin"

: "${TLS_CA_PASS:?TLS_CA_PASS must be set - refusing to let keytool fall back to its interactive prompt}"
: "${TLS_ADMIN_PASS:?TLS_ADMIN_PASS must be set - refusing to let keytool fall back to its interactive prompt}"

ks="$OUT_DIR/clients/admin/admin.p12"
csr="$OUT_DIR/clients/admin/admin.csr"
reply="$OUT_DIR/clients/admin/admin.pem"

keytool -genkeypair \
  -alias admin \
  -keyalg RSA -keysize 3072 \
  -validity "$NODE_VALIDITY_DAYS" \
  -dname "CN=admin, OU=NIFI" \
  -keystore "$ks" -storetype PKCS12 \
  -storepass:env TLS_ADMIN_PASS

keytool -certreq \
  -alias admin \
  -keystore "$ks" -storetype PKCS12 \
  -storepass:env TLS_ADMIN_PASS \
  -file "$csr"

# clientAuth only - this cert authenticates a person to NiFi, never a server.
keytool -gencert \
  -alias "$CA_ALIAS" \
  -keystore "$OUT_DIR/ca/ca.p12" -storetype PKCS12 \
  -storepass:env TLS_CA_PASS \
  -infile "$csr" -outfile "$reply" -rfc \
  -validity "$NODE_VALIDITY_DAYS" -startdate -1d \
  -ext ku:c=digitalSignature \
  -ext eku=clientAuth

keytool -importcert -noprompt \
  -alias "$CA_ALIAS" \
  -file "$OUT_DIR/ca/ca.pem" \
  -keystore "$ks" -storetype PKCS12 \
  -storepass:env TLS_ADMIN_PASS

keytool -importcert -noprompt \
  -alias admin \
  -file "$reply" \
  -keystore "$ks" -storetype PKCS12 \
  -storepass:env TLS_ADMIN_PASS

chmod 600 "$ks" "$csr" "$reply"

echo "Admin client cert ready: $ks"
echo "Import it into the browser; identity string: CN=admin, OU=NIFI"
