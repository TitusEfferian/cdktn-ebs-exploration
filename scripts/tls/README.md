# NiFi cluster TLS — keytool script suite

Standalone scripts that mint everything the 3-node NiFi cluster needs to move
from HTTP to mutual TLS: a private CA, one keystore per node, a shared
truststore, and (optionally) a browser client cert for the initial admin.

**Run these on a machine with JDK 21** (only `keytool` and bash ≥ 3.2 are
needed — no openssl, no NiFi toolkit; NiFi 2.x removed `tls-toolkit`, and
keytool alone covers the whole flow because node keys are generated directly
inside their final `keystore.p12` and never exported). They are NOT part of
`cdktn synth/deploy` and do not run on the instances.

## Usage — Windows PowerShell (Git Bash runs the scripts)

Needs JDK 21+ on the Windows PATH (`keytool -version` and `java -version` must
answer) plus Git for Windows. Bare `bash` in PowerShell resolves to Windows'
WSL stub (`System32\bash.exe`) — invoke Git Bash by full path instead. `$env:`
variables are inherited by Git Bash, so the scripts see them like exports.

```powershell
cd scripts\tls

# passwords: set them (>=16 random chars recommended) or let the scripts prompt.
# TLS_NODE_PASS must be COLON-FREE (02 enforces it); avoid single quotes.
$env:TLS_CA_PASS    = '...'   # CA keystore (the crown jewels)
$env:TLS_NODE_PASS  = '...'   # the three node keystores (shared password)
$env:TLS_TRUST_PASS = '...'   # the shared truststore
$env:TLS_ADMIN_PASS = '...'   # only for 04 (browser client cert)

$gitbash = 'C:\Program Files\Git\bin\bash.exe'
& $gitbash 01-generate-ca.sh
& $gitbash 02-generate-node-certs.sh
& $gitbash 03-generate-truststore.sh
& $gitbash 04-generate-admin-cert.sh   # optional
& $gitbash 99-verify.sh
```

## Usage — Linux / macOS / WSL / Docker

No local JDK? `docker run --rm -it -v "${PWD}\scripts\tls:/tls" -w /tls
eclipse-temurin:21 bash` (from the repo root, PowerShell) drops you into a
JDK-21 shell with this folder mounted; outputs land back on the host.

```sh
cd scripts/tls

# passwords: export them (>=16 random chars recommended) or let the scripts prompt
export TLS_CA_PASS=...      # CA keystore (the crown jewels)
export TLS_NODE_PASS=...    # the three node keystores (shared password; NO colons)
export TLS_TRUST_PASS=...   # the shared truststore
export TLS_ADMIN_PASS=...   # only for 04 (browser client cert)

bash 01-generate-ca.sh
bash 02-generate-node-certs.sh
bash 03-generate-truststore.sh
bash 04-generate-admin-cert.sh   # optional
bash 99-verify.sh
```

(`bash 01-...` rather than `./01-...` sidesteps the execute bit, which a
Windows checkout does not carry.) `00-env.sh` is sourced by the others and
refuses to run directly — always start at `01`.

Re-running against existing output fails on purpose (keytool errors on existing
aliases); `FORCE=1` deletes and regenerates that script's outputs — sh:
`FORCE=1 bash 02-generate-node-certs.sh`; PowerShell: `$env:FORCE='1';
& $gitbash 02-generate-node-certs.sh; $env:FORCE=$null`. Config knobs (env overrides, defaults in `00-env.sh`):
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

## Delivering to the nodes (Secrets Manager, via CLI)

Everything the cluster consumes is uploaded BY YOU into six placeholder-seeded
Secrets Manager secrets (Terraform ignores value changes forever; NiFi tasks
crash-loop with a clear log line until the four material secrets are real —
that is deliberate). The outputs under `out/` stay local — the folder is
gitignored (`scripts/tls/out`).

PowerShell (from the repo root; `$REGION = "ap-northeast-1"`):

```powershell
# passwords (plain strings; keystore password must be COLON-FREE — 02 enforces it):
aws secretsmanager put-secret-value --region $REGION --secret-id ecs-ebs-demo/nifi/tls/keystore-password   --secret-string 'the-TLS_NODE_PASS-you-used'
aws secretsmanager put-secret-value --region $REGION --secret-id ecs-ebs-demo/nifi/tls/truststore-password --secret-string 'the-TLS_TRUST_PASS-you-used'

# material (base64 text of the PKCS12 binaries — ECS injects secrets as env
# vars, so the container wrapper decodes these back to files at start):
aws secretsmanager put-secret-value --region $REGION --secret-id ecs-ebs-demo/nifi/tls/keystore-nifi-1 --secret-string ([Convert]::ToBase64String([IO.File]::ReadAllBytes("scripts\tls\out\nodes\nifi-1\keystore.p12")))
aws secretsmanager put-secret-value --region $REGION --secret-id ecs-ebs-demo/nifi/tls/keystore-nifi-2 --secret-string ([Convert]::ToBase64String([IO.File]::ReadAllBytes("scripts\tls\out\nodes\nifi-2\keystore.p12")))
aws secretsmanager put-secret-value --region $REGION --secret-id ecs-ebs-demo/nifi/tls/keystore-nifi-3 --secret-string ([Convert]::ToBase64String([IO.File]::ReadAllBytes("scripts\tls\out\nodes\nifi-3\keystore.p12")))
aws secretsmanager put-secret-value --region $REGION --secret-id ecs-ebs-demo/nifi/tls/truststore --secret-string ([Convert]::ToBase64String([IO.File]::ReadAllBytes("scripts\tls\out\shared\truststore.p12")))
```

bash/zsh equivalents use `base64 -w0 < file` (GNU) or `base64 < file` (macOS —
no `-w0`, already unwrapped for files this small).

Cautions:

- `TLS_CA_PASS` and `TLS_ADMIN_PASS` deliberately have NO secret in AWS: the CA
  keystore (and its password) never leaves the build machine, and the admin
  cert password stays with the admin's browser.
- PKCS12 protection is exactly as strong as its password: JDK 21 writes PBES2
  AES-256, but a short password is offline-brute-forceable by anyone holding
  the blob. The keystores now live in Secrets Manager next to their passwords
  (separate secrets, same execution-role scope) — an execution-role compromise
  yields both, so treat that role's scope as the real security boundary.
  ≥16 random chars regardless.
- `ca/ca.p12` has **no reason to exist in AWS or on any node** — nodes only
  need the CA *cert*, already embedded in their keystore/truststore. Losing
  ca.p12 + its password to an attacker = ability to mint trusted certs for the
  cluster.
- The truststore is public material but integrity-critical: whoever can
  `put-secret-value` on `.../tls/truststore` can splice in a rogue CA and MITM
  the cluster. Write access to these secrets = cluster compromise.
- Rotation: rerun `02` (fresh output via `FORCE=1`) for the affected node,
  re-upload that node's base64 keystore, then
  `aws ecs update-service --force-new-deployment` for that one service. CA
  rotation (rare) = new `01` + reissue everything + re-upload all four material
  secrets + roll all three services.

## How TLS is wired in the stack (ON from first boot)

`AUTH=tls` is set in the task definition from day one; the image's own
`secure.sh` writes `nifi.security.*` and the authorizers entries from env, and
the bootstrap's self-signed-cert/single-user generation is skipped (it only
runs with blank passwords + missing store files). The container wrapper in
`constructs/container-definitions.ts` runs BEFORE `start.sh` and:

1. refuses to start while any `*_B64` secret still holds the placeholder
   (loud `exit 1` → ECS restarts until you upload — fail-closed);
2. decodes `KEYSTORE_B64`/`TRUSTSTORE_B64` to
   `/opt/nifi/nifi-current/conf/*.p12` (`chmod 600`), then unsets the blobs;
3. fixes the **image gap**: `secure.sh` writes only `Node Identity 1`, but a
   3-node mTLS cluster needs all three node DNs as BOTH access-policy
   `Node Identity 1..3` AND user-group `Initial User Identity` entries on
   EVERY node (NiFi refuses to start otherwise) — the wrapper sed-appends the
   missing entries, identically on all nodes;
4. re-points `users.xml`/`authorizations.xml` into persisted `flow_storage/`
   so UI-added users/policies survive a full-cluster restart;
5. disables RAW site-to-site (start.sh would default the port to 10000).

Env per node (see `container-definitions.ts` for the full table):
`KEYSTORE_PATH/TYPE`, `TRUSTSTORE_PATH/TYPE` (PKCS12; `KEY_PASSWORD` omitted —
PKCS12 key pass == store pass), `INITIAL_ADMIN_IDENTITY=CN=admin, OU=NIFI`,
`NODE_IDENTITY=CN=nifi-1.nifi.internal, OU=NIFI` (literal `nifi-1` on ALL
nodes — authorizers.xml must be identical cluster-wide),
`NIFI_WEB_HTTPS_PORT=8443`, `NIFI_WEB_HTTPS_HOST=<own FQDN>` (**never blank**:
it doubles as the node API address advertised to peers — blank would advertise
`localhost` and self-loop replication), `NIFI_WEB_PROXY_HOST=localhost:8443,
127.0.0.1:8443,<the three FQDNs>:8443`.

- Cluster protocol (11443) and load-balance (6342) become mutual TLS
  automatically once keystore+truststore+passwords exist — no extra env.
- **Identity strings are RFC1779** (comma + **space**): NiFi formats X.509
  identities via `X500Principal.getName(RFC1779)`, so authorization entries
  are byte-for-byte `CN=nifi-1.nifi.internal, OU=NIFI` etc. The `-dname`
  values in these scripts produce exactly that; no identity-mapping needed.
- The health check calls `/nifi-api/authentication/configuration` (one of the
  three unauthenticated paths in 2.x) with the node's OWN keystore as client
  cert — under pure `AUTH=tls` the web port REQUIRES client certs
  (`needClientAuth`), which is also why the browser needs `admin.p12`.
- ZooKeeper TLS (optional, later): the SAME CA + truststore can serve it —
  NiFi's `nifi.zookeeper.security.*` properties fall back to the main
  `nifi.security.*` stores when blank. Cut server certs for `zk-1..3` by adding
  them to `NODE_NAMES` (same SAN/EKU shape) and configure the ZK image's quorum
  TLS separately.
