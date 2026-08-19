#!/usr/bin/env bash
# 99-verify.sh - keytool-only sanity checks over the generated artifacts.
#
# Checks per node keystore: PrivateKeyEntry present, chain length 2, SAN carries
# the Cloud Map FQDN, EKU has serverAuth + clientAuth. Checks the shared
# truststore holds exactly one trusted cert. Exit non-zero on any failure.
#
# keytool quirks handled here: its "keytool error: ..." line goes to STDOUT
# (not stderr), so capture 2>&1 and gate on the exit code BEFORE grepping; and
# `grep -c` prints the 0 itself while exiting 1 on zero matches, so `|| true`
# only absorbs grep's status (never `|| echo 0`, which would yield "0\n0").
set -Eeuo pipefail

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
. "$script_dir/00-env.sh"

require_jdk 21
prompt_secret TLS_NODE_PASS 'Node keystore password'
prompt_secret TLS_TRUST_PASS 'Truststore password'

: "${TLS_NODE_PASS:?TLS_NODE_PASS must be set - refusing to let keytool fall back to its interactive prompt}"
: "${TLS_TRUST_PASS:?TLS_TRUST_PASS must be set - refusing to let keytool fall back to its interactive prompt}"

failures=0

check() {
  # check DESCRIPTION LISTING PATTERN - grep -F the listing for the pattern.
  local desc=$1 listing=$2 pattern=$3
  if printf '%s\n' "$listing" | grep -qF -- "$pattern"; then
    printf '  ok   %s\n' "$desc"
  else
    printf '  FAIL %s (missing: %s)\n' "$desc" "$pattern" >&2
    failures=$((failures + 1))
  fi
}

for node in "${NODE_NAMES[@]}"; do
  ks="$OUT_DIR/nodes/$node/keystore.p12"
  echo "== $node ($ks)"
  if [[ ! -f $ks ]]; then
    echo "  FAIL keystore missing - run 02-generate-node-certs.sh" >&2
    failures=$((failures + 1))
    continue
  fi
  if ! listing=$(keytool -list -v -keystore "$ks" -storetype PKCS12 -storepass:env TLS_NODE_PASS 2>&1); then
    printf '%s\n' "$listing" >&2
    exit 1
  fi
  check "private key entry" "$listing" "Entry type: PrivateKeyEntry"
  check "chain length 2 (leaf + CA)" "$listing" "Certificate chain length: 2"
  check "SAN has ${node}.${DNS_SUFFIX}" "$listing" "${node}.${DNS_SUFFIX}"
  check "EKU serverAuth" "$listing" "serverAuth"
  check "EKU clientAuth" "$listing" "clientAuth"
  if [[ ! -f "$OUT_DIR/nodes/$node/truststore.p12" ]]; then
    echo "  FAIL truststore.p12 missing - run 03-generate-truststore.sh" >&2
    failures=$((failures + 1))
  fi
done

ts="$OUT_DIR/shared/truststore.p12"
echo "== shared truststore ($ts)"
if [[ -f $ts ]]; then
  if ! listing=$(keytool -list -keystore "$ts" -storetype PKCS12 -storepass:env TLS_TRUST_PASS 2>&1); then
    printf '%s\n' "$listing" >&2
    exit 1
  fi
  entries=$(printf '%s\n' "$listing" | grep -c 'trustedCertEntry') || true
  if [[ $entries == 1 ]]; then
    printf '  ok   exactly one trusted cert entry\n'
  else
    printf '  FAIL expected 1 trustedCertEntry, found %s\n' "$entries" >&2
    failures=$((failures + 1))
  fi
else
  echo "  FAIL missing - run 03-generate-truststore.sh" >&2
  failures=$((failures + 1))
fi

echo
if ((failures > 0)); then
  echo "VERIFY FAILED: $failures problem(s)" >&2
  exit 1
fi
echo "VERIFY OK - artifacts under $OUT_DIR are complete"
