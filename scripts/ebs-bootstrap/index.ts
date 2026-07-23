// On-instance boot program: idempotently discover, attach, and mount a tagged
// EBS volume, then register this host with its ECS cluster. Ported from the
// original scripts/user-data.sh; runs as root on the ECS-optimized AL2023
// (arm64) AMI. The ASG launches each instance once, so this runs on a fresh
// first boot per instance (and again on every ASG replacement).
//
// INVARIANT: this NEVER reformats a device that already carries a filesystem —
// that is what preserves data across instance replacement in the EBS demo.
//
// Config is passed by scripts/bootstrap.sh via environment variables:
//   VOLUME_TAG    value of the Name tag on the target EBS volume
//   CLUSTER_NAME  ECS cluster this instance should register with
//
// Logging is plain stdout/stderr with a step prefix; the bootstrap already fans
// our output to file + syslog + console, so we do not duplicate that here.
//
// This file is orchestration only; the steps live in ./ecs, ./imds, ./volume,
// and ./disk (esbuild bundles the whole graph into one file for the instance).

import { EC2Client, EC2ServiceException } from "@aws-sdk/client-ec2";
import { upsertEcsCluster } from "./ecs";
import { getInstanceIdentity } from "./imds";
import { discoverVolume, ensureAttached } from "./volume";
import { resolveDevice, prepareFilesystem, updateFstab, mountAndPermit } from "./disk";
import { errlog, log, nowIso, requireEnv } from "./utils";

// --- Orchestration -----------------------------------------------------------
async function main(): Promise<void> {
  log(`=== ebs-bootstrap start: ${nowIso()} ===`);

  const volumeTag = requireEnv("VOLUME_TAG");
  const clusterName = requireEnv("CLUSTER_NAME");

  // Register with ECS FIRST, before the (potentially slow) EBS work below.
  await upsertEcsCluster(clusterName);

  const { instanceId, az, region } = await getInstanceIdentity();
  log(`instance=${instanceId} az=${az} region=${region}`);

  const ec2 = new EC2Client({ region, retryMode: "standard", maxAttempts: 10 });
  try {
    const { volumeId, attachedInstanceId } = await discoverVolume(ec2, volumeTag, az);
    log(`target volume=${volumeId} serial=${volumeId.replace(/-/g, "")}`);

    await ensureAttached(ec2, volumeId, instanceId, attachedInstanceId === instanceId);

    const device = await resolveDevice(volumeId);
    log(`resolved ${volumeId} -> ${device}`);

    const { fsType, uuid } = await prepareFilesystem(device);
    log(`filesystem on ${device}: type=${fsType} uuid=${uuid}`);

    await updateFstab(uuid, fsType);
    await mountAndPermit();
  } finally {
    ec2.destroy(); // close keep-alive sockets so the process can exit promptly
  }

  log(`=== ebs-bootstrap complete: ${nowIso()} ===`);
}

main().catch((err: unknown) => {
  // ERR-trap equivalent: log the failure, then set a non-zero exit code WITHOUT
  // calling process.exit(), so buffered stdout/stderr can drain first.
  errlog(`FAILED: ${err instanceof Error ? err.message : String(err)}`);
  if (err instanceof EC2ServiceException) {
    errlog(`  ec2 error name=${err.name} requestId=${err.$metadata?.requestId ?? "unknown"}`);
  } else if (err instanceof Error && err.stack) {
    errlog(err.stack);
  }
  process.exitCode = 1;
});
