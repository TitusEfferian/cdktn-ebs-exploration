// Container definitions, built as typed factories so the service constructs
// stay declarative. Keys are ECS camelCase (the module JSON-encodes them into
// the task definition), unlike Terraform snake_case block arguments.

export interface ContainerMountPoint {
  readonly sourceVolume: string;
  readonly containerPath: string;
  readonly readOnly: boolean;
}

export interface ContainerPortMapping {
  // awsvpc: containerPort only (hostPort must be blank or identical).
  readonly containerPort: number;
  readonly protocol: "tcp" | "udp";
}

export interface ContainerEnvVar {
  readonly name: string;
  readonly value: string;
}

export interface ContainerSecret {
  readonly name: string;
  // Full ARN of an SSM parameter (or Secrets Manager secret).
  readonly valueFrom: string;
}

export interface ContainerHealthCheck {
  readonly command: string[];
  readonly interval: number;
  readonly timeout: number;
  readonly retries: number;
  // Grace before failures count toward retries; ECS hard-caps this at 300s —
  // longer effective grace comes from retries x interval on top.
  readonly startPeriod: number;
}

export interface ContainerUlimit {
  readonly name: string;
  readonly softLimit: number;
  readonly hardLimit: number;
}

export interface ContainerDefinition {
  readonly image: string;
  readonly essential: boolean;
  readonly cpu?: number;
  readonly memory?: number;
  readonly memoryReservation?: number;
  readonly entryPoint?: string[];
  readonly command?: string[];
  readonly environment?: ContainerEnvVar[];
  readonly secrets?: ContainerSecret[];
  readonly portMappings?: ContainerPortMapping[];
  readonly mountPoints?: ContainerMountPoint[];
  readonly healthCheck?: ContainerHealthCheck;
  readonly ulimits?: ContainerUlimit[];
  readonly stopTimeout?: number;
  readonly linuxParameters?: { readonly initProcessEnabled: boolean };
  readonly readonlyRootFilesystem: boolean;
}

// Build the busybox container definitions. `sourceVolume` must equal the ECS
// service volume key so the mount resolves.
export function containerDefinitions(
  sourceVolume: string,
): Record<string, ContainerDefinition> {
  return {
    app: {
      image: "busybox:latest",
      essential: true,
      cpu: 256,
      memory: 512,
      // busybox has no bash and no `sleep infinity`; keep it alive with a loop
      command: ["sh", "-c", "while true; do sleep 3600; done"],
      mountPoints: [
        {
          sourceVolume, // must equal the volume key in the service
          containerPath: "/data",
          readOnly: false,
        },
      ],
      linuxParameters: {
        initProcessEnabled: true, // required for ECS Exec
      },
      readonlyRootFilesystem: false, // Exec injects the SSM agent into the FS
    },
  };
}

// ---------------------------------------------------------------------------
// NiFi 2.x cluster node
// ---------------------------------------------------------------------------

// NiFi runs HTTPS/AUTH=tls from FIRST BOOT. With AUTH=tls the image's own
// secure.sh wires nifi.security.* + authorizers.xml from env, and the
// bootstrap's cert generation + single-user setup are skipped (generation
// requires blank passwords AND missing store files — ours exist with
// passwords). The keystores arrive as BASE64 TEXT env vars injected from
// Secrets Manager (ECS injects secrets as env, never as files), so this
// wrapper, in order:
//   1. refuses to start while a *_B64 secret still holds the Terraform
//      placeholder — loud exit 1, ECS restarts the container until the
//      operator uploads real base64 via put-secret-value (fail-closed),
//   2. decodes them to the .p12 paths secure.sh expects (conf/ is a fresh
//      anonymous volume per task; nothing in the image wipes it afterwards),
//   3. appends the two MISSING node identities to authorizers.xml — secure.sh
//      fills only the "...1" slots, and FileAccessPolicyProvider throws at
//      startup ("Unable to locate node ... to seed policies") when a Node
//      Identity is not also a user-group-provider user. sed, NOT xmlstarlet:
//      xmlstarlet re-serializes the empty elements self-closing, which would
//      break secure.sh's own literal sed patterns,
//   4. re-points users.xml/authorizations.xml into persisted flow_storage so
//      UI-added users/policies survive a FULL-cluster restart (a single
//      replaced node would re-inherit them from the cluster anyway),
//   5. blanks the RAW site-to-site port default — start.sh would otherwise
//      set 10000 and NiFi would bind a TLS S2S listener nobody uses,
//   6. keeps the flow_storage re-point + growth-cap property edits (conf/
//      must NOT be bind-mounted — a host mount would shadow the image's conf
//      and leave no nifi.properties at all; the flow lives in flow_storage),
//   7. execs start.sh — image keeps its env handling, ZK wiring, log tailing
//      and signal traps; NiFi becomes PID 1 for direct SIGTERM.
//
// STRING RULES: this is ONE JSON string handed to /bin/sh -c (dash). No `${`
// sequence anywhere (Terraform template collision in cdk.tf.json — bare $VAR
// is safe, dash expands it at runtime; the RAW-port sed pattern deliberately
// starts at `{`). sed scripts containing double quotes ride in sh single
// quotes; `|` is the sed delimiter; `\n` in replacements is GNU sed. sed
// exits 0 on no-match, so the drift failure mode is DOWNSTREAM but still
// loud: unpatched authorizers.xml aborts NiFi startup, and a changed
// properties layout surfaces as the health check failing.
function nifiTlsWrapper(ns: string): string {
  const n1 = `CN=nifi-1.${ns}, OU=NIFI`;
  const n2 = `CN=nifi-2.${ns}, OU=NIFI`;
  const n3 = `CN=nifi-3.${ns}, OU=NIFI`;
  const az = "/opt/nifi/nifi-current/conf/authorizers.xml";
  return [
    `case "$KEYSTORE_B64" in PLACEHOLDER*) echo 'TLS keystore secret not populated - run the put-secret-value steps in README-nifi-cluster.md' >&2; exit 1;; esac`,
    `case "$TRUSTSTORE_B64" in PLACEHOLDER*) echo 'TLS truststore secret not populated - run the put-secret-value steps in README-nifi-cluster.md' >&2; exit 1;; esac`,
    `printf '%s' "$KEYSTORE_B64" | base64 -d > /opt/nifi/nifi-current/conf/keystore.p12`,
    `printf '%s' "$TRUSTSTORE_B64" | base64 -d > /opt/nifi/nifi-current/conf/truststore.p12`,
    `chmod 600 /opt/nifi/nifi-current/conf/keystore.p12 /opt/nifi/nifi-current/conf/truststore.p12`,
    // The decoded files are all secure.sh needs; drop the ~7 KiB blobs so they
    // never linger in NiFi's process environment.
    `unset KEYSTORE_B64 TRUSTSTORE_B64`,
    // Idempotency guards (grep -qF): a restarted container reuses its
    // filesystem, so the appends must not run twice. The empty "...1"
    // elements are preserved verbatim — secure.sh's own seds fill them later.
    `if ! grep -qF 'Initial User Identity 2' ${az}; then sed -i 's|<property name="Initial User Identity 1"></property>|<property name="Initial User Identity 1"></property>\\n        <property name="Initial User Identity 2">${n1}</property>\\n        <property name="Initial User Identity 3">${n2}</property>\\n        <property name="Initial User Identity 4">${n3}</property>|' ${az}; fi`,
    `if ! grep -qF 'Node Identity 2' ${az}; then sed -i 's|<property name="Node Identity 1"></property>|<property name="Node Identity 1"></property>\\n        <property name="Node Identity 2">${n2}</property>\\n        <property name="Node Identity 3">${n3}</property>|' ${az}; fi`,
    // Persist users/policies across full-cluster restarts (no-op if the
    // upstream template ever changes these paths — then they stay ephemeral).
    `sed -i 's|<property name="Users File">./conf/users.xml</property>|<property name="Users File">/opt/nifi/nifi-current/flow_storage/users.xml</property>|' ${az}`,
    `sed -i 's|<property name="Authorizations File">./conf/authorizations.xml</property>|<property name="Authorizations File">/opt/nifi/nifi-current/flow_storage/authorizations.xml</property>|' ${az}`,
    `if grep -qF '{NIFI_REMOTE_INPUT_SOCKET_PORT:-10000}' /opt/nifi/scripts/start.sh; then sed -i 's|{NIFI_REMOTE_INPUT_SOCKET_PORT:-10000}|{NIFI_REMOTE_INPUT_SOCKET_PORT}|' /opt/nifi/scripts/start.sh; fi`,
    "sed -i" +
      " -e 's|^nifi.flow.configuration.file=.*|nifi.flow.configuration.file=/opt/nifi/nifi-current/flow_storage/flow.json.gz|'" +
      " -e 's|^nifi.flow.configuration.archive.dir=.*|nifi.flow.configuration.archive.dir=/opt/nifi/nifi-current/flow_storage/archive/|'" +
      " -e 's|^nifi.provenance.repository.max.storage.size=.*|nifi.provenance.repository.max.storage.size=2 GB|'" +
      " -e 's|^nifi.provenance.repository.max.storage.time=.*|nifi.provenance.repository.max.storage.time=7 days|'" +
      " -e 's|^nifi.content.repository.archive.max.usage.percentage=.*|nifi.content.repository.archive.max.usage.percentage=50%|'" +
      " /opt/nifi/nifi-current/conf/nifi.properties",
    "exec /opt/nifi/scripts/start.sh",
  ].join(" &&\n");
}

export interface NifiContainerOptions {
  readonly slotName: string;
  readonly namespaceName: string;
  // zk-1.<ns>:2181,zk-2.<ns>:2181,zk-3.<ns>:2181
  readonly zkConnectString: string;
  // Whole-secret Secrets Manager ARNs; resolved to AWSCURRENT at container
  // start. All five are launch-time dependencies: a deleted/unreadable secret
  // fails every new NiFi task launch.
  readonly sensitiveKeySecretArn: string;
  // Consumed by secure.sh (AUTH=tls) and by the health check's curl.
  readonly tlsKeystorePasswordArn: string;
  readonly tlsTruststorePasswordArn: string;
  // base64 of THIS node's keystore.p12 / the shared truststore.p12 — decoded
  // to files by the wrapper (ECS can inject secrets only as env vars).
  readonly tlsKeystoreB64SecretArn: string;
  readonly tlsTruststoreB64SecretArn: string;
}

export function nifiContainerDefinitions(
  opts: NifiContainerOptions,
): Record<string, ContainerDefinition> {
  const address = `${opts.slotName}.${opts.namespaceName}`;
  return {
    nifi: {
      image: "apache/nifi:2.10.0", // multi-arch manifest; arm64 auto-selected on t4g
      essential: true,
      // Task memory is 3072 (hard, service level); reserve 2048 so a stray
      // co-placed task could never starve the JVM.
      memoryReservation: 2048,
      entryPoint: ["/bin/sh", "-c"],
      command: [nifiTlsWrapper(opts.namespaceName)], // ONE array element — extras would become $0/positional params
      environment: [
        { name: "NIFI_CLUSTER_IS_NODE", value: "true" },
        // Stable Cloud Map FQDN, not the container hostname (awsvpc forbids the
        // hostname parameter; the image would default to $HOSTNAME otherwise).
        { name: "NIFI_CLUSTER_ADDRESS", value: address },
        // No default exists for the cluster protocol port (blank ships in both
        // nifi.properties and the image) — it MUST be set; 11443 is the Admin
        // Guide's example value and matches the task SG.
        { name: "NIFI_CLUSTER_NODE_PROTOCOL_PORT", value: "11443" },
        // Written into BOTH nifi.properties and state-management.xml by the image.
        { name: "NIFI_ZK_CONNECT_STRING", value: opts.zkConnectString },
        { name: "NIFI_ZK_ROOT_NODE", value: "/nifi" },
        // 3 fixed nodes: every node votes, so don't wait the default 5 minutes.
        { name: "NIFI_ELECTION_MAX_WAIT", value: "1 min" },
        { name: "NIFI_ELECTION_MAX_CANDIDATES", value: "3" },
        { name: "NIFI_JVM_HEAP_INIT", value: "1g" },
        { name: "NIFI_JVM_HEAP_MAX", value: "1g" },
        // --- TLS (image's own secured path; secure.sh consumes these) ------
        { name: "AUTH", value: "tls" },
        { name: "KEYSTORE_PATH", value: "/opt/nifi/nifi-current/conf/keystore.p12" },
        { name: "KEYSTORE_TYPE", value: "PKCS12" },
        { name: "TRUSTSTORE_PATH", value: "/opt/nifi/nifi-current/conf/truststore.p12" },
        { name: "TRUSTSTORE_TYPE", value: "PKCS12" },
        // KEY_PASSWORD deliberately absent: PKCS12 forces key pass == store
        // pass, and secure.sh defaults it to KEYSTORE_PASSWORD.
        // RFC1779 (comma + space) — must match the admin cert's DN
        // byte-for-byte; NiFi formats X.509 identities exactly this way.
        { name: "INITIAL_ADMIN_IDENTITY", value: "CN=admin, OU=NIFI" },
        // LITERAL nifi-1 on ALL THREE nodes: secure.sh fills "Node Identity 1"
        // with this value and the wrapper appends identities 2/3, so every
        // node ends up with an IDENTICAL authorizers.xml (required for
        // matching authorizer fingerprints across the cluster).
        { name: "NODE_IDENTITY", value: `CN=nifi-1.${opts.namespaceName}, OU=NIFI` },
        { name: "NIFI_WEB_HTTPS_PORT", value: "8443" },
        // NEVER blank: nifi.web.https.host doubles as the node API address
        // ADVERTISED TO PEERS for REST replication — blank advertises
        // "localhost" and every peer replicates to itself. Per-node FQDN also
        // means 127.0.0.1 is NOT bound in-container (health check uses the
        // FQDN for this reason).
        { name: "NIFI_WEB_HTTPS_HOST", value: address },
        // Hygiene: 2.x validates X-ProxyHost/X-Forwarded-Host headers (when
        // present) and Host-header PORTS against this list; node replication
        // is exempt. Covers the SSM port-forward (localhost) and peer names.
        {
          name: "NIFI_WEB_PROXY_HOST",
          value:
            `localhost:8443,127.0.0.1:8443,` +
            `nifi-1.${opts.namespaceName}:8443,nifi-2.${opts.namespaceName}:8443,nifi-3.${opts.namespaceName}:8443`,
        },
      ],
      secrets: [
        // Required for cluster nodes (>=12 chars, IDENTICAL on all three — it
        // encrypts sensitive values in flow.json.gz; a mismatch breaks flow
        // inheritance). Delivered from Secrets Manager so it never sits in the
        // task def; the value is injected at container START only — after a
        // manual put-secret-value, force a new deployment on the nifi services
        // for tasks to pick it up.
        { name: "NIFI_SENSITIVE_PROPS_KEY", valueFrom: opts.sensitiveKeySecretArn },
        // KEYSTORE_PASSWORD is consumed by secure.sh AND by the health
        // check's curl (file:password syntax — the TLS scripts enforce a
        // colon-free password). Never unset in the wrapper.
        { name: "KEYSTORE_PASSWORD", valueFrom: opts.tlsKeystorePasswordArn },
        { name: "TRUSTSTORE_PASSWORD", valueFrom: opts.tlsTruststorePasswordArn },
        // base64 text of the .p12 binaries (Secrets Manager holds text; the
        // wrapper decodes to files, then unsets these). Placeholder values
        // fail the placeholder guard — deliberate crash-loop until populated.
        { name: "KEYSTORE_B64", valueFrom: opts.tlsKeystoreB64SecretArn },
        { name: "TRUSTSTORE_B64", valueFrom: opts.tlsTruststoreB64SecretArn },
      ],
      portMappings: [
        { containerPort: 8443, protocol: "tcp" }, // HTTPS UI/API + node-to-node REST replication
        { containerPort: 11443, protocol: "tcp" }, // cluster protocol (mutual TLS, automatic)
        { containerPort: 6342, protocol: "tcp" }, // load-balanced connections (TLS, automatic)
        // RAW site-to-site (10000) is disabled by the wrapper — no mapping.
      ],
      mountPoints: [
        // sourceVolume keys must equal the ECS service volume map keys. conf is
        // deliberately absent: host bind mounts don't copy image contents, so
        // mounting conf would shadow nifi.properties entirely; conf regenerates
        // from env on every boot, and the flow lives in flow_storage instead.
        { sourceVolume: "flowfile", containerPath: "/opt/nifi/nifi-current/flowfile_repository", readOnly: false },
        { sourceVolume: "content", containerPath: "/opt/nifi/nifi-current/content_repository", readOnly: false },
        { sourceVolume: "provenance", containerPath: "/opt/nifi/nifi-current/provenance_repository", readOnly: false },
        { sourceVolume: "database", containerPath: "/opt/nifi/nifi-current/database_repository", readOnly: false },
        { sourceVolume: "state", containerPath: "/opt/nifi/nifi-current/state", readOnly: false },
        { sourceVolume: "flow", containerPath: "/opt/nifi/nifi-current/flow_storage", readOnly: false },
      ],
      // NiFi juggles many repo/socket FDs; the Admin Guide recommends raising
      // nofile well above the Docker default.
      ulimits: [{ name: "nofile", softLimit: 50000, hardLimit: 50000 }],
      healthCheck: {
        // /nifi-api/authentication/configuration is one of exactly three
        // UNAUTHENTICATED paths in 2.x (access/config is gone). Under pure
        // AUTH=tls the web port REQUIRES client certs (needClientAuth, not
        // want) — the node's own keystore doubles as the client cert (its EKU
        // includes clientAuth). FQDN, not localhost: with a per-node
        // https.host, 127.0.0.1 is not bound. Liveness only, on purpose: a
        // quorum-membership check would flap DNS (a FAILED health check
        // deregisters the Cloud Map record) and restart nodes during
        // legitimate ZK outages. Answers as soon as Jetty is up, including
        // during flow election.
        command: [
          "CMD-SHELL",
          `curl -fsk --max-time 10 --cert-type P12 --cert /opt/nifi/nifi-current/conf/keystore.p12:"$KEYSTORE_PASSWORD" "https://$NIFI_CLUSTER_ADDRESS:8443/nifi-api/authentication/configuration" -o /dev/null || exit 1`,
        ],
        interval: 30,
        timeout: 10,
        retries: 5, // + startPeriod 300 => ~7.5 min total grace for NAR unpack + election
        startPeriod: 300,
      },
      // Image start.sh traps SIGTERM -> nifi.sh stop (graceful.shutdown 20s
      // default); 120s comfortably covers stop overhead + JVM exit.
      stopTimeout: 120,
      readonlyRootFilesystem: false, // NiFi writes work/, logs/, conf/ inside the container FS
    },
  };
}

// ---------------------------------------------------------------------------
// ZooKeeper 3.9 ensemble member
// ---------------------------------------------------------------------------

export interface ZookeeperContainerOptions {
  // 1..3 — becomes ZOO_MY_ID. The entrypoint writes /data/myid only when the
  // file is absent, so the id persists on the slot volume; a volume must never
  // be re-homed to a different slot.
  readonly ordinal: number;
  readonly namespaceName: string;
}

export function zookeeperContainerDefinitions(
  opts: ZookeeperContainerOptions,
): Record<string, ContainerDefinition> {
  const ns = opts.namespaceName;
  return {
    zookeeper: {
      // Docker Official Image via the ECR Public mirror — dodges Docker Hub's
      // per-IP pull limit that all six instances share behind the single NAT.
      image: "public.ecr.aws/docker/library/zookeeper:3.9.5",
      essential: true,
      environment: [
        { name: "ZOO_MY_ID", value: String(opts.ordinal) },
        // IDENTICAL on all three members (official compose pattern — the
        // entrypoint does no own-entry substitution). Syntax:
        // server.<id>=<host>:<quorum>:<election>;<client port>.
        {
          name: "ZOO_SERVERS",
          value: `server.1=zk-1.${ns}:2888:3888;2181 server.2=zk-2.${ns}:2888:3888;2181 server.3=zk-3.${ns}:2888:3888;2181`,
        },
        { name: "ZOO_STANDALONE_ENABLED", value: "false" },
        // Jetty AdminServer would bind 0.0.0.0:8080 — dead weight here.
        { name: "ZOO_ADMINSERVER_ENABLED", value: "false" },
        // Effective default whitelist is srvr only; ruok backs the health
        // check, mntr the runbook.
        { name: "ZOO_4LW_COMMANDS_WHITELIST", value: "srvr,ruok,mntr" },
        // 20s follower-connect window (10*2000ms) tolerates container/DNS
        // cold-start jitter; image defaults (5/2) are tight for ECS churn.
        { name: "ZOO_INIT_LIMIT", value: "10" },
        { name: "ZOO_SYNC_LIMIT", value: "5" },
        // Image default purgeInterval=0 DISABLES purging — 64 MiB-preallocated
        // txn logs would accumulate on the persistent volume forever.
        { name: "ZOO_AUTOPURGE_PURGEINTERVAL", value: "1" },
        { name: "ZOO_AUTOPURGE_SNAPRETAINCOUNT", value: "3" },
        // Load-bearing: each member's own A record may be missing or stale at
        // startup (Cloud Map registers on task start). Without this, binding
        // the election/leader ports to the resolved own-address fails 3 times
        // and the process EXITS -> restart loop until DNS settles. With it, ZK
        // binds the wildcard and DNS can only delay quorum, never crash it.
        { name: "ZOO_CFG_EXTRA", value: "quorumListenOnAllIPs=true" },
        { name: "ZK_SERVER_HEAP", value: "512" }, // MB; coordination-only load
      ],
      portMappings: [
        { containerPort: 2181, protocol: "tcp" }, // client (NiFi)
        { containerPort: 2888, protocol: "tcp" }, // quorum
        { containerPort: 3888, protocol: "tcp" }, // leader election
      ],
      mountPoints: [
        // dataDir (myid + snapshots + epoch files) and dataLogDir (txn logs).
        // Same gp3 volume is correctness-safe; the "dedicated log device" advice
        // is a throughput optimization irrelevant at coordination-only rates.
        { sourceVolume: "data", containerPath: "/data", readOnly: false },
        { sourceVolume: "datalog", containerPath: "/datalog", readOnly: false },
      ],
      healthCheck: {
        // ruok = liveness only ("imok" even while quorum is still forming).
        // Never gate on leader/follower state — that would kill members during
        // legitimate election windows and can flap the whole ensemble.
        command: ["CMD-SHELL", "echo ruok | nc -w 2 localhost 2181 | grep -q imok"],
        interval: 15,
        timeout: 5,
        retries: 3,
        startPeriod: 90,
      },
      stopTimeout: 60,
      readonlyRootFilesystem: false, // entrypoint chowns/writes conf inside the container FS
    },
  };
}
