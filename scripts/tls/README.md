# NiFi cluster TLS — keytool script suite

Standalone scripts that mint everything the 3-node NiFi cluster needs to move
from HTTP to mutual TLS: a private CA, one keystore per node, a shared
truststore, and (optionally) a browser client cert for the initial admin.

**Run these on a machine with JDK 21** (only `keytool` and bash ≥ 3.2 are
needed — no openssl, no NiFi toolkit; NiFi 2.x removed `tls-toolkit`, and
keytool alone covers the whole flow because node keys are generated directly
inside their final `keystore.p12` and never exported). They are NOT part of
`cdktn synth/deploy` and do not run on the instances.

## Usage

```sh
cd scripts/tls

# passwords: export them (>=16 random chars recommended) or let the scripts prompt
export TLS_CA_PASS=...      # CA keystore (the crown jewels)
export TLS_NODE_PASS=...    # the three node keystores (shared password)
export TLS_TRUST_PASS=...   # the shared truststore
export TLS_ADMIN_PASS=...   # only for 04 (browser client cert)

./01-generate-ca.sh
./02-generate-node-certs.sh
./03-generate-truststore.sh
./04-generate-admin-cert.sh   # optional
./99-verify.sh
```

Re-running against existing output fails on purpose (keytool errors on existing
aliases); `FORCE=1 ./02-generate-node-certs.sh` deletes and regenerates that
script's outputs. Config knobs (env overrides, defaults in `00-env.sh`):
`TLS_DNS_SUFFIX` (default `nifi.internal` — **must match the Cloud Map
namespace in `stacks/my-stack.ts` and is frozen once certs are issued**),
`TLS_OUT_DIR`, `TLS_CA_VALIDITY_DAYS` (3650), `TLS_NODE_VALIDITY_DAYS` (825).

## Output layout

```
out/
  ca/       ca.p12  SECRET — never uploaded anywhere; signs/rotates everything
            ca.pem  public CA certificate
  nodes/
    nifi-1/ keystore.p12 + truststore.p12     <- the ONLY files node 1 needs
    nifi-2/ ...
    nifi-3/ ...
  shared/   truststore.p12                    <- single trust anchor (CA only)
  work/     <node>.csr / <node>.pem           <- intermediates, safe to delete
  clients/
    admin/  admin.p12                         <- browser import, hand-delivered
```

Each node cert: RSA 3072, 825 days (backdated 1 day for clock skew), SAN =
`dns:<node>.<suffix>, dns:<node>, dns:localhost, ip:127.0.0.1` (localhost/IP
cover the SSM port-forward browser path), KU `digitalSignature,keyEncipherment`,
EKU `serverAuth,clientAuth` — **both** EKUs because every node is TLS server
AND client to its peers (NiFi's cluster socket hardcodes `needClientAuth`).
PKCS12 everywhere; keytool forces key password == store password in `.p12`.

## Delivering to the nodes (later)

The natural channel is the stack's existing private bundle bucket + the boot
program (instance role already has scoped `s3:GetObject`): sync
`out/nodes/<node>/` to a per-node prefix and extend the boot program to fetch
into the slot volume. Cautions:

- **Passwords must NOT ride alongside the keystores** in the bucket — a reader
  of the prefix would get both, making the PKCS12 encryption worthless. Deliver
  passwords via SSM SecureString (the stack already demonstrates the pattern
  with the sensitive-props key).
- PKCS12 protection is exactly as strong as its password: JDK 21 writes PBES2
  AES-256, but a short password is offline-brute-forceable by anyone holding
  the file. ≥16 random chars if keystores ever touch S3.
- `ca/ca.p12` has **no reason to exist in S3 or on any node** — nodes only need
  the CA *cert*, already embedded in their keystore/truststore. Losing ca.p12 +
  its password to an attacker = ability to mint trusted certs for the cluster.
- The truststore is public material but integrity-critical: write access to
  wherever it is distributed must be as locked down as read access to the
  keystores (overwriting it with a rogue CA enables MITM).
- Rotation: rerun `02` (fresh output via `FORCE=1`) for the affected node,
  redistribute its `keystore.p12`, restart that node. CA rotation (rare) = new
  `01` + reissue everything + replace the shared truststore everywhere.

## Enabling TLS on the cluster (future work — the deploy side)

With artifacts on each node's volume, the Docker image's own secured path
takes over (no `start.sh` patching needed in TLS mode — the current HTTP
entrypoint wrapper in `constructs/container-definitions.ts` is removed):

- Env per NiFi container: `AUTH=tls`, `KEYSTORE_PATH`, `KEYSTORE_TYPE=PKCS12`,
  `KEYSTORE_PASSWORD`, (`KEY_PASSWORD` optional — defaults to the keystore
  password, which is exactly what PKCS12 enforces anyway), `TRUSTSTORE_PATH`,
  `TRUSTSTORE_TYPE=PKCS12`, `TRUSTSTORE_PASSWORD`,
  `INITIAL_ADMIN_IDENTITY=CN=admin, OU=NIFI`.
- The equivalent `nifi.properties` keys (for reference):
  `nifi.security.keystore|keystoreType|keystorePasswd|keyPasswd` (falls back to
  `keystorePasswd` when blank), `nifi.security.truststore|truststoreType|truststorePasswd`,
  plus `nifi.web.https.port=8443` and a blank `nifi.web.http.port`.
- **Identity strings are RFC1779** (comma + **space**): NiFi formats X.509
  identities via `X500Principal.getName(RFC1779)`, so authorization entries
  must be byte-for-byte `CN=nifi-1.nifi.internal, OU=NIFI` etc. The `-dname`
  values in these scripts already produce exactly that.
- **Known image gap:** the image's `secure.sh` writes only ONE
  `Node Identity 1` from the `NODE_IDENTITY` env var, but a 3-node mTLS
  cluster needs `Node Identity 1..3` in `authorizers.xml` on every node. The
  future TLS wrapper must add the other two entries itself (sed/xmlstarlet)
  before first secured start. Also note `users.xml`/`authorizations.xml` are
  generated ONCE on first secured start — identity changes later require
  deleting both files.
- Cluster/S2S flip back to secure: the entrypoint patch that forces
  `nifi.remote.input.secure=false` must not run in TLS mode; TLS between nodes
  turns on automatically once a keystore + password are configured.
- ZooKeeper TLS (optional, later): the SAME CA + truststore can serve it —
  NiFi's `nifi.zookeeper.security.*` properties fall back to the main
  `nifi.security.*` stores when blank. Cut server certs for `zk-1..3` by adding
  them to `NODE_NAMES` (same SAN/EKU shape) and configure the ZK image's quorum
  TLS separately.
- SSM port-forward to HTTPS later: browse `https://localhost:8443/nifi` and set
  `NIFI_WEB_PROXY_HOST=localhost:8443` (Host-header validation is active on
  TLS, unlike HTTP).
