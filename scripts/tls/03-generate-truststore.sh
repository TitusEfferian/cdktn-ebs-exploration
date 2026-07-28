#!/usr/bin/env bash
# 03-generate-truststore.sh - the ONE shared truststore (CA cert only).
#
# Every node (and every client that must verify nodes) trusts the same single
# anchor; one file prevents drift. Public material, but INTEGRITY-critical:
# whoever can overwrite it wherever it is distributed can splice in a rogue CA.
#
# Produces:
#   out/shared/truststore.p12
#   out/nodes/<node>/truststore.p12   (byte-identical copies, so each node dir
#                                      is a complete, individually-syncable set)
set -Eeuo pipefail

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
. "$script_dir/00-env.sh"

require_jdk 21
prompt_secret TLS_TRUST_PASS 'Truststore password'

if [[ ! -f "$OUT_DIR/ca/ca.pem" ]]; then
  echo "error: $OUT_DIR/ca/ca.pem not found - run 01-generate-ca.sh first" >&2
  exit 1
fi

fresh_target "$OUT_DIR/shared"
mkdir -p -- "$OUT_DIR/shared"

: "${TLS_TRUST_PASS:?TLS_TRUST_PASS must be set - refusing to let keytool fall back to its interactive prompt}"

keytool -importcert -noprompt \
  -alias "$CA_ALIAS" \
  -file "$OUT_DIR/ca/ca.pem" \
  -keystore "$OUT_DIR/shared/truststore.p12" -storetype PKCS12 \
  -storepass:env TLS_TRUST_PASS

chmod 600 "$OUT_DIR/shared/truststore.p12"

# Plain copies (public material; no keytool step needed per node).
for node in "${NODE_NAMES[@]}"; do
  if [[ -d "$OUT_DIR/nodes/$node" ]]; then
    cp -- "$OUT_DIR/shared/truststore.p12" "$OUT_DIR/nodes/$node/truststore.p12"
    chmod 600 "$OUT_DIR/nodes/$node/truststore.p12"
    echo "node $node: truststore.p12 copied"
  fi
done

echo "Truststore ready: $OUT_DIR/shared/truststore.p12"
echo "Next: 99-verify.sh (and optionally 04-generate-admin-cert.sh)"
