#!/usr/bin/env bash
# 00-env.sh - shared config for the NiFi TLS suite. Source from 01-99; do not execute.
#
# Runs on a separate machine with JDK 21 (keytool) - NOT on the instances and
# NOT during cdktn synth/deploy. Bash 3.2-compatible on purpose: stock macOS
# bash is 3.2.57 forever, and #!/usr/bin/env bash resolves to it unless a newer
# bash is installed (no associative arrays, no ${var,,}, no mapfile, no &>>,
# regex kept in variables for 3.2's =~ quoting rules).
#
# Passwords come from env vars or an interactive prompt - NEVER hardcoded, and
# never on keytool's argv (keytool reads them via -storepass:env VAR, so the
# value is invisible to `ps`). The stack consumes this suite's output through
# SIX placeholder-seeded Secrets Manager secrets (README-nifi-cluster.md has
# the exact upload commands):
#   ecs-ebs-demo/nifi/tls/keystore-password    = TLS_NODE_PASS (colon-free!)
#   ecs-ebs-demo/nifi/tls/truststore-password  = TLS_TRUST_PASS
#   ecs-ebs-demo/nifi/tls/keystore-nifi-{1,2,3} = base64 of out/nodes/<n>/keystore.p12
#   ecs-ebs-demo/nifi/tls/truststore           = base64 of out/shared/truststore.p12
# After populating you can pull a password back here, e.g.:
#   TLS_NODE_PASS=$(aws secretsmanager get-secret-value \
#     --secret-id ecs-ebs-demo/nifi/tls/keystore-password \
#     --query SecretString --output text)
# TLS_CA_PASS / TLS_ADMIN_PASS have NO AWS copy on purpose (build-machine only).
# DN note: a literal comma inside a DN value must
# be written as \\, inside double quotes (collapses to backslash-comma for
# RFC-2253 escaping) - avoid commas in CN/OU values entirely if you can.
[ -n "${BASH_VERSION:-}" ] || { echo 'error: these scripts require bash' >&2; return 1 2>/dev/null || exit 1; }
if [[ ${BASH_SOURCE[0]} == "$0" ]]; then
  echo "error: source 00-env.sh from the numbered scripts; do not execute it" >&2
  exit 1
fi
if [[ -n ${_TLS_ENV_SOURCED:-} ]]; then return 0; fi
_TLS_ENV_SOURCED=1
if (( BASH_VERSINFO[0] < 3 || (BASH_VERSINFO[0] == 3 && BASH_VERSINFO[1] < 2) )); then
  echo "error: bash >= 3.2 required; this is ${BASH_VERSION}" >&2
  return 1
fi

umask 077   # keystores/keys/CSRs are created 0600 (dirs 0700)

TLS_ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)

# The three NiFi cluster nodes. ZooKeeper nodes are NOT listed: the demo runs
# NiFi<->ZK unauthenticated; if ZK TLS is wanted later, the same CA signs certs
# for zk-1..3 with the same SAN shape (add them here and rerun 02).
NODE_NAMES=(nifi-1 nifi-2 nifi-3)

# MUST match the Cloud Map namespace in stacks/my-stack.ts (nifi.internal).
# Freeze before the first signing run: changing it means re-issuing every cert
# AND updating the node-identity DNs registered with NiFi authorization.
DNS_SUFFIX=${TLS_DNS_SUFFIX:-nifi.internal}

OUT_DIR=${TLS_OUT_DIR:-$TLS_ROOT/out}
CA_VALIDITY_DAYS=${TLS_CA_VALIDITY_DAYS:-3650}
NODE_VALIDITY_DAYS=${TLS_NODE_VALIDITY_DAYS:-825}
CA_ALIAS=${TLS_CA_ALIAS:-nifi-ca}
# RFC1779 form (comma + space) - NiFi formats certificate identities exactly
# this way, and authorizers.xml node identities must match byte-for-byte.
CA_DNAME=${TLS_CA_DNAME:-"CN=NiFi CA, OU=NIFI"}

_tls_on_error() {
  printf '%s: FAILED (exit %s) at line %s: %s\n' "$0" "$1" "$2" "$3" >&2
}
# don't install an ERR trap into an interactive shell that sources this to poke around
if [[ $- != *i* ]]; then
  trap '_tls_on_error "$?" "$LINENO" "$BASH_COMMAND"' ERR
fi

# prompt_secret VARNAME "Prompt text": use the env value if set (validated),
# else prompt twice. keytool's own minimum is 6 chars; a keystore blob parked in
# Secrets Manager is only as strong as this password, so >=16 random chars is
# the real bar.
prompt_secret() {
  local var=$1 prompt=$2 v1 v2
  if [[ -n ${!var:-} ]]; then
    v1=${!var}
    if [[ ${#v1} -lt 6 ]]; then
      echo "error: $var is set but shorter than 6 chars (keytool minimum)" >&2
      return 1
    fi
    if [[ ${#v1} -lt 16 ]]; then
      echo "warning: $var is shorter than 16 chars - fine for a lab, weak for keystore blobs parked in Secrets Manager" >&2
    fi
    export "$var"
    return 0
  fi
  if [ ! -t 0 ]; then
    echo "error: $var is unset and stdin is not a terminal; export $var or run interactively" >&2
    return 1
  fi
  while :; do
    IFS= read -r -s -p "$prompt: " v1; printf '\n' >&2
    IFS= read -r -s -p "$prompt (confirm): " v2; printf '\n' >&2
    if [[ -n $v1 && $v1 == "$v2" && ${#v1} -ge 6 ]]; then break; fi
    echo 'Empty, mismatched, or shorter than 6 chars (keytool minimum); try again.' >&2
  done
  printf -v "$var" '%s' "$v1"
  export "$var"
}

# fresh_target PATH...: refuse to touch existing outputs unless FORCE=1, in
# which case delete them so keytool can regenerate (keytool errors on existing
# aliases, so "overwrite" must be delete-then-recreate). This is the suite's
# only destructive act - keep it loud.
fresh_target() {
  local path
  for path in "$@"; do
    if [[ -e $path ]]; then
      if [[ ${FORCE:-0} != 1 ]]; then
        echo "error: $path already exists; re-run with FORCE=1 to delete and regenerate it" >&2
        return 1
      fi
      echo "FORCE=1: removing $path" >&2
      rm -rf -- "$path"
    fi
  done
}

# require_jdk MIN_MAJOR: check java+keytool on PATH and java major version (JEP 223 aware)
require_jdk() {
  local min=$1 raw re ver major
  command -v java >/dev/null 2>&1 || { echo 'error: java not on PATH; install JDK 21' >&2; return 1; }
  command -v keytool >/dev/null 2>&1 || { echo 'error: keytool not on PATH; add the JDK bin dir' >&2; return 1; }
  raw=$(java -version 2>&1) || { echo 'error: java -version failed' >&2; return 1; }  # -version prints to STDERR
  re='version "([^"]+)"'                          # regex kept in a var: required for bash 3.2 =~ quoting rules
  if [[ $raw =~ $re ]]; then ver=${BASH_REMATCH[1]}; else
    echo "error: cannot parse java version from: $raw" >&2; return 1
  fi
  case $ver in
    1.*) major=${ver#1.}; major=${major%%[!0-9]*} ;;   # 1.8.0_292 -> 8
    *)   major=${ver%%[!0-9]*} ;;                      # 21.0.3 / 21-ea / 21 -> 21
  esac
  if [ -z "$major" ] || [ "$major" -lt "$min" ]; then
    echo "error: JDK >= $min required; found java $ver" >&2
    return 1
  fi
}

mkdir -p -- "$OUT_DIR"
