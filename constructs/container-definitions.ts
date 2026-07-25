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

// The official apache/nifi 2.x image removed its unsecured-HTTP mode: start.sh
// unconditionally forces nifi.web.https.* and nifi.remote.input.secure=true
// (which CRASHES an HTTP-only node at startup). NiFi itself fully supports
// HTTP clustering, so this wrapper patches the three offending start.sh lines,
// pre-sets the HTTP + persistence + growth-cap properties start.sh never
// touches, then execs start.sh — keeping all its env handling (cluster/ZK
// wiring, log tailing, signal traps) and making NiFi PID 1 for direct SIGTERM.
//
// sed exits 0 on no-match; grep -qF guards make container start FAIL if the
// upstream image changes these lines instead of silently running with wrong
// ports. Fail-safe either way: an unpatched image comes up HTTPS:8443, the
// HTTP health check fails, and the task is replaced loudly — never silently
// corrupted.
//
// Quote layering: this string is JSON-escaped only (no outer shell), so the
// single quotes inside the start.sh patterns are literal; those sed scripts are
// wrapped in sh double quotes, the nifi.properties seds (no single quotes) in
// sh single quotes. No `$`, backticks, double quotes, or backslashes anywhere
// inside the sed scripts; `|` is the sed delimiter because patterns contain `/`.
const NIFI_HTTP_WRAPPER = [
  `grep -qF "prop_replace 'nifi.web.https.port'" /opt/nifi/scripts/start.sh`,
  `sed -i "s|^prop_replace 'nifi.web.https.port'.*|prop_replace 'nifi.web.https.port' ''|" /opt/nifi/scripts/start.sh`,
  `grep -qF "prop_replace 'nifi.web.https.host'" /opt/nifi/scripts/start.sh`,
  `sed -i "s|^prop_replace 'nifi.web.https.host'.*|prop_replace 'nifi.web.https.host' ''|" /opt/nifi/scripts/start.sh`,
  `grep -qF "prop_replace 'nifi.remote.input.secure'" /opt/nifi/scripts/start.sh`,
  `sed -i "s|^prop_replace 'nifi.remote.input.secure'.*|prop_replace 'nifi.remote.input.secure' 'false'|" /opt/nifi/scripts/start.sh`,
  // Properties start.sh never rewrites: HTTP listener (blank host = all
  // interfaces), flow.json re-pointed onto the persistent bind mount (conf/
  // itself must NOT be bind-mounted — a host mount would shadow the image's
  // conf and leave no nifi.properties at all), and growth caps so the 30 GiB
  // slot volume cannot fill (provenance bounded; content archive cleanup
  // starts at 50% filesystem usage).
  "sed -i" +
    " -e 's|^nifi.web.http.port=.*|nifi.web.http.port=8080|'" +
    " -e 's|^nifi.web.http.host=.*|nifi.web.http.host=|'" +
    " -e 's|^nifi.flow.configuration.file=.*|nifi.flow.configuration.file=/opt/nifi/nifi-current/flow_storage/flow.json.gz|'" +
    " -e 's|^nifi.flow.configuration.archive.dir=.*|nifi.flow.configuration.archive.dir=/opt/nifi/nifi-current/flow_storage/archive/|'" +
    " -e 's|^nifi.provenance.repository.max.storage.size=.*|nifi.provenance.repository.max.storage.size=2 GB|'" +
    " -e 's|^nifi.provenance.repository.max.storage.time=.*|nifi.provenance.repository.max.storage.time=7 days|'" +
    " -e 's|^nifi.content.repository.archive.max.usage.percentage=.*|nifi.content.repository.archive.max.usage.percentage=50%|'" +
    " /opt/nifi/nifi-current/conf/nifi.properties",
  "exec /opt/nifi/scripts/start.sh",
].join(" &&\n");

export interface NifiContainerOptions {
  readonly slotName: string;
  readonly namespaceName: string;
  // zk-1.<ns>:2181,zk-2.<ns>:2181,zk-3.<ns>:2181
  readonly zkConnectString: string;
  readonly sensitiveKeyParameterArn: string;
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
      command: [NIFI_HTTP_WRAPPER], // ONE array element — extras would become $0/positional params
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
      ],
      secrets: [
        // Required for cluster nodes (>=12 chars, IDENTICAL on all three — it
        // encrypts sensitive values in flow.json.gz; a mismatch breaks flow
        // inheritance). Delivered from SSM so it never sits in the task def.
        { name: "NIFI_SENSITIVE_PROPS_KEY", valueFrom: opts.sensitiveKeyParameterArn },
      ],
      portMappings: [
        { containerPort: 8080, protocol: "tcp" }, // web UI/API + node-to-node REST replication
        { containerPort: 11443, protocol: "tcp" }, // cluster protocol
        { containerPort: 6342, protocol: "tcp" }, // load-balanced connections
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
        // Anonymous 200 over HTTP once Jetty is up (curl ships in the image).
        // Liveness only, on purpose: a quorum-membership check would flap DNS
        // (a FAILED health check deregisters the Cloud Map record) and restart
        // nodes during legitimate ZK outages.
        command: ["CMD-SHELL", "curl -f http://localhost:8080/nifi-api/system-diagnostics || exit 1"],
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
