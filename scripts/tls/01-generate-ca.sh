#!/usr/bin/env bash
# 01-generate-ca.sh - create the cluster CA keystore and export its certificate.
#
# Produces:
#   out/ca/ca.p12   CA private key + self-signed cert  (SECRET - never leaves
#                   this machine; needed only to sign/rotate node certs)
#   out/ca/ca.pem   CA certificate (public trust anchor for 02/03)
set -Eeuo pipefail
# -e exit on failure  -E ERR trap fires inside functions too
# -u unset variable = error  -o pipefail pipeline fails if any stage fails

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
. "$script_dir/00-env.sh"

require_jdk 21
prompt_secret TLS_CA_PASS 'CA keystore password'

fresh_target "$OUT_DIR/ca"
mkdir -p -- "$OUT_DIR/ca"

# Tripwire: keytool with -storepass:env on an UNSET var prints a warning and
# falls back to an interactive prompt - a hung script. ${VAR:?} exits first.
: "${TLS_CA_PASS:?TLS_CA_PASS must be set - refusing to let keytool fall back to its interactive prompt}"

# RSA 4096 for the CA (sign-time-only cost); default sigalg for this size is
# SHA384withRSA, so no -sigalg needed. bc pathlen:0 = this CA may sign only
# end-entity certs, never a sub-CA. -keyalg is REQUIRED on JDK 21 (no default).
keytool -genkeypair \
  -alias "$CA_ALIAS" \
  -keyalg RSA -keysize 4096 \
  -validity "$CA_VALIDITY_DAYS" \
  -dname "$CA_DNAME" \
  -ext bc:c=ca:true,pathlen:0 \
  -ext ku:c=keyCertSign,cRLSign \
  -keystore "$OUT_DIR/ca/ca.p12" -storetype PKCS12 \
  -storepass:env TLS_CA_PASS

keytool -exportcert -rfc \
  -alias "$CA_ALIAS" \
  -keystore "$OUT_DIR/ca/ca.p12" -storetype PKCS12 \
  -storepass:env TLS_CA_PASS \
  -file "$OUT_DIR/ca/ca.pem"

chmod 600 "$OUT_DIR/ca/ca.p12" "$OUT_DIR/ca/ca.pem"

echo "CA ready:"
echo "  keystore : $OUT_DIR/ca/ca.p12  (SECRET - keep on this machine)"
echo "  cert     : $OUT_DIR/ca/ca.pem"
echo "Next: 02-generate-node-certs.sh, then 03-generate-truststore.sh"
