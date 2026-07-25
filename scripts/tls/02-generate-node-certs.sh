#!/usr/bin/env bash
# 02-generate-node-certs.sh - per-node keystores signed by the CA from 01.
#
# For each node in NODE_NAMES produces:
#   out/nodes/<node>/keystore.p12   ONE PrivateKeyEntry, chain [leaf, CA]
#   out/work/<node>/<node>.csr|.pem intermediates (kept out of nodes/ so a
#                                   naive `s3 sync out/nodes` uploads exactly
#                                   one file per node)
#
# keytool has NO private-key export: each node's key is generated directly
# inside its final keystore.p12 and never moves; only CSRs and (public) certs
# cross directory boundaries. That is why no openssl is needed.
set -Eeuo pipefail

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
. "$script_dir/00-env.sh"

require_jdk 21
prompt_secret TLS_CA_PASS 'CA keystore password'
prompt_secret TLS_NODE_PASS 'Node keystore password (shared by the three node keystores)'

if [[ ! -f "$OUT_DIR/ca/ca.p12" || ! -f "$OUT_DIR/ca/ca.pem" ]]; then
  echo "error: CA not found under $OUT_DIR/ca - run 01-generate-ca.sh first" >&2
  exit 1
fi

: "${TLS_CA_PASS:?TLS_CA_PASS must be set - refusing to let keytool fall back to its interactive prompt}"
: "${TLS_NODE_PASS:?TLS_NODE_PASS must be set - refusing to let keytool fall back to its interactive prompt}"

for node in "${NODE_NAMES[@]}"; do
  fresh_target "$OUT_DIR/nodes/$node" "$OUT_DIR/work/$node"
  mkdir -p -- "$OUT_DIR/nodes/$node" "$OUT_DIR/work/$node"

  ks="$OUT_DIR/nodes/$node/keystore.p12"
  csr="$OUT_DIR/work/$node/$node.csr"
  reply="$OUT_DIR/work/$node/$node.pem"

  # PKCS12 note: keytool forces key password == store password in .p12 files
  # (a differing -keypass is warned about and IGNORED), so none is passed.
  # DN is RFC1779 form (comma + space): NiFi formats certificate identities
  # exactly this way and authorizers.xml entries must match byte-for-byte.
  keytool -genkeypair \
    -alias "$node" \
    -keyalg RSA -keysize 3072 \
    -validity "$NODE_VALIDITY_DAYS" \
    -dname "CN=${node}.${DNS_SUFFIX}, OU=NIFI" \
    -keystore "$ks" -storetype PKCS12 \
    -storepass:env TLS_NODE_PASS

  keytool -certreq \
    -alias "$node" \
    -keystore "$ks" -storetype PKCS12 \
    -storepass:env TLS_NODE_PASS \
    -file "$csr"

  # CA signs. CSR extensions are NOT honored by -gencert by default, so every
  # extension is re-stated explicitly here (the safe form; never `honored=all`).
  # Both EKUs are required: every NiFi node is a TLS SERVER and a TLS CLIENT to
  # its peers (the cluster socket hardcodes needClientAuth). SANs cover the
  # Cloud Map FQDN, the bare slot name, and localhost/127.0.0.1 for the SSM
  # port-forward browser path. -startdate -1d tolerates clock skew.
  # The comma-separated san= value must reach keytool as ONE argv word - the
  # double quotes guarantee that (commas are not IFS characters anyway).
  keytool -gencert \
    -alias "$CA_ALIAS" \
    -keystore "$OUT_DIR/ca/ca.p12" -storetype PKCS12 \
    -storepass:env TLS_CA_PASS \
    -infile "$csr" -outfile "$reply" -rfc \
    -validity "$NODE_VALIDITY_DAYS" -startdate -1d \
    -ext "san=dns:${node}.${DNS_SUFFIX},dns:${node},dns:localhost,ip:127.0.0.1" \
    -ext ku:c=digitalSignature,keyEncipherment \
    -ext eku=serverAuth,clientAuth

  # Import the CA as a trusted entry FIRST: that lets the single-leaf reply
  # build its chain prompt-free. (-trustcacerts would only consult the JDK's
  # bundled cacerts - useless for a private CA; deliberately absent.)
  keytool -importcert -noprompt \
    -alias "$CA_ALIAS" \
    -file "$OUT_DIR/ca/ca.pem" \
    -keystore "$ks" -storetype PKCS12 \
    -storepass:env TLS_NODE_PASS

  # Reply import into the KEY alias replaces the self-signed cert with the
  # chain [leaf, CA]; expect "Certificate reply was installed in keystore".
  keytool -importcert -noprompt \
    -alias "$node" \
    -file "$reply" \
    -keystore "$ks" -storetype PKCS12 \
    -storepass:env TLS_NODE_PASS

  chmod 600 "$ks" "$csr" "$reply"
  echo "node $node: $ks"
done

echo "Node keystores ready. Next: 03-generate-truststore.sh"
