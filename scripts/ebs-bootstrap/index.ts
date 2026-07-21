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

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile, mkdir, realpath, readdir, rename, stat, chmod } from "node:fs/promises";
import { MetadataService } from "@aws-sdk/ec2-metadata-service";
import {
  EC2Client,
  DescribeVolumesCommand,
  AttachVolumeCommand,
  waitUntilVolumeAvailable,
  EC2ServiceException,
} from "@aws-sdk/client-ec2";

const execFileAsync = promisify(execFile);

// --- Constants / tunables (mirror the original user-data.sh) -----------------
const DEVICE_REQUEST = "/dev/sdf"; // requested attach name; Nitro remaps to /dev/nvme?n1
const MOUNT_POINT = "/mnt/ebs";
const DEFAULT_FS_TYPE = "ext4";
const MAX_WAIT_MS = 300_000; // max wait for any single state change
const INTERVAL_MS = 5_000; // seconds between polls
const IMDS_WAIT_MS = 60_000; // max wait for the first IMDS success
const ECS_CONFIG = "/etc/ecs/ecs.config";
const FSTAB = "/etc/fstab";
const LOG_PREFIX = "[ebs-bootstrap]";

function log(msg: string): void {
  console.log(`${LOG_PREFIX} ${msg}`);
}
function errlog(msg: string): void {
  console.error(`${LOG_PREFIX} ${msg}`);
}
function nowIso(): string {
  return new Date().toISOString();
}
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
// Bash-style progress line: "...waiting for X (elapsed/total s)".
function waitBanner(desc: string, startMs: number, totalMs: number): void {
  const elapsedS = Math.round((Date.now() - startMs) / 1000);
  log(`  ...waiting for ${desc} (${elapsedS}/${Math.round(totalMs / 1000)}s)`);
}
// Fold a transient API error into a poll iteration: log its name and keep going.
function logTransient(op: string, err: unknown): void {
  const name = err instanceof Error ? err.name : "unknown";
  log(`  ...${op} not ready yet (${name}); retrying`);
}

// Write a system file atomically: write a sibling temp file, preserve the target's
// mode, then rename over it (same-directory rename is atomic on Linux). Prevents a
// truncated /etc/ecs/ecs.config or /etc/fstab if the process dies mid-write.
async function atomicWrite(filePath: string, content: string): Promise<void> {
  let mode = 0o644;
  try {
    mode = (await stat(filePath)).mode & 0o777; // preserve the existing file's mode
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  const tmp = `${filePath}.tmp-${process.pid}`;
  await writeFile(tmp, content, { encoding: "utf8", mode });
  await chmod(tmp, mode); // writeFile's mode is subject to umask; set it exactly
  await rename(tmp, filePath);
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") {
    throw new Error(`missing required environment variable ${name}`);
  }
  return value;
}

// Run a command, ignoring any failure (best-effort side effects like `udevadm settle`).
async function runQuiet(cmd: string, args: string[]): Promise<void> {
  try {
    await execFileAsync(cmd, args);
  } catch {
    /* ignore */
  }
}

// Run a command and return whether it exited 0 (used as a predicate).
async function execOk(cmd: string, args: string[]): Promise<boolean> {
  try {
    await execFileAsync(cmd, args);
    return true;
  } catch {
    return false;
  }
}

// --- Register with the ECS cluster (do this FIRST, before slow EBS work) ------
// Upsert ECS_CLUSTER in /etc/ecs/ecs.config: replace every existing ECS_CLUSTER=
// line, or append one if none exists. Never duplicates. Ensures the ECS agent
// reads the right cluster at startup and never falls back to "default".
async function upsertEcsCluster(clusterName: string): Promise<void> {
  await mkdir("/etc/ecs", { recursive: true });
  const desired = `ECS_CLUSTER=${clusterName}`;

  let existing = "";
  try {
    existing = await readFile(ECS_CONFIG, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }

  const body = existing.endsWith("\n") ? existing.slice(0, -1) : existing;
  const lines = existing.length > 0 ? body.split("\n") : [];
  let replaced = false;
  const out = lines.map((line) => {
    if (/^ECS_CLUSTER=/.test(line)) {
      replaced = true;
      return desired;
    }
    return line;
  });
  if (!replaced) out.push(desired);

  await atomicWrite(ECS_CONFIG, out.join("\n") + "\n");
  log(`ECS_CLUSTER set to ${clusterName}`);
}

// --- IMDS --------------------------------------------------------------------
interface InstanceIdentity {
  instanceId: string;
  az: string;
  region: string;
}

// MetadataService handles the IMDSv2 token automatically. Poll up to IMDS_WAIT_MS
// for the first success (the metadata endpoint can lag early in boot).
async function getInstanceIdentity(): Promise<InstanceIdentity> {
  const meta = new MetadataService({});
  const start = Date.now();
  const deadline = start + IMDS_WAIT_MS;
  for (;;) {
    try {
      const instanceId = (await meta.request("/latest/meta-data/instance-id", {})).trim();
      const az = (await meta.request("/latest/meta-data/placement/availability-zone", {})).trim();
      // Read the region directly rather than stripping the AZ suffix, so this
      // stays correct in Local Zones / Wavelength (e.g. us-west-2-lax-1a).
      const region = (await meta.request("/latest/meta-data/placement/region", {})).trim();
      return { instanceId, az, region };
    } catch (err) {
      if (Date.now() >= deadline) {
        throw new Error(
          `could not reach IMDS within ${IMDS_WAIT_MS / 1000}s: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      waitBanner("IMDS to respond", start, IMDS_WAIT_MS);
      await sleep(INTERVAL_MS);
    }
  }
}

// --- Volume discovery --------------------------------------------------------
interface DiscoveredVolume {
  volumeId: string;
  attachedInstanceId?: string;
}

// Find the volume in THIS AZ by its Name tag. Poll until it exists.
async function discoverVolume(
  ec2: EC2Client,
  volumeTag: string,
  az: string,
): Promise<DiscoveredVolume> {
  const start = Date.now();
  const deadline = start + MAX_WAIT_MS;
  for (;;) {
    const res = await ec2
      .send(
        new DescribeVolumesCommand({
          Filters: [
            { Name: "tag:Name", Values: [volumeTag] },
            { Name: "availability-zone", Values: [az] },
          ],
        }),
      )
      .catch((err: unknown) => {
        // Fold transient API errors (e.g. AuthFailure while the instance-profile
        // credentials propagate early in boot) into "not ready yet — keep polling".
        logTransient("describe-volumes (discover)", err);
        return undefined;
      });
    const volumes = res?.Volumes ?? [];
    if (volumes.length > 1) {
      // The original silently took Volumes[0]; refuse to guess between duplicates.
      const ids = volumes.map((v) => v.VolumeId ?? "?").join(", ");
      throw new Error(
        `more than one volume tagged Name=${volumeTag} in ${az} (${ids}) — refusing to guess which to attach`,
      );
    }
    if (volumes.length === 1) {
      const volume = volumes[0];
      return {
        volumeId: volume.VolumeId!,
        attachedInstanceId: volume.Attachments?.[0]?.InstanceId,
      };
    }
    if (Date.now() >= deadline) {
      throw new Error(`no volume tagged Name=${volumeTag} in ${az} after ${MAX_WAIT_MS / 1000}s`);
    }
    waitBanner(`EBS volume tagged Name=${volumeTag} in ${az}`, start, MAX_WAIT_MS);
    await sleep(INTERVAL_MS);
  }
}

// --- Attach ------------------------------------------------------------------
// Poll DescribeVolumes until the ATTACHMENT (not just the volume) reads
// "attached" to this instance. The built-in waitUntilVolumeInUse only checks the
// volume State, which is not sufficient here.
async function waitForAttachment(
  ec2: EC2Client,
  volumeId: string,
  instanceId: string,
): Promise<void> {
  const start = Date.now();
  const deadline = start + MAX_WAIT_MS;
  for (;;) {
    const res = await ec2
      .send(new DescribeVolumesCommand({ VolumeIds: [volumeId] }))
      .catch((err: unknown) => {
        logTransient("describe-volumes (attachment)", err);
        return undefined;
      });
    const attachment = res?.Volumes?.[0]?.Attachments?.[0];
    if (attachment?.State === "attached" && attachment.InstanceId === instanceId) {
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error(`attachment of ${volumeId} did not reach 'attached' within ${MAX_WAIT_MS / 1000}s`);
    }
    waitBanner(`attachment of ${volumeId} to reach 'attached'`, start, MAX_WAIT_MS);
    await sleep(INTERVAL_MS);
  }
}

async function ensureAttached(
  ec2: EC2Client,
  volumeId: string,
  instanceId: string,
  alreadyHere: boolean,
): Promise<void> {
  if (alreadyHere) {
    log(`volume ${volumeId} already attached to ${instanceId} — skipping attach`);
    return;
  }

  const start = Date.now();
  const deadline = start + MAX_WAIT_MS;
  // Retry loop within the overall budget: a just-terminated previous instance may
  // still be detaching, so AttachVolume can return VolumeInUse / IncorrectState.
  // On those, re-wait for the volume to become available and try again.
  for (;;) {
    const remainingS = Math.max(5, Math.ceil((deadline - Date.now()) / 1000));
    try {
      await waitUntilVolumeAvailable(
        { client: ec2, maxWaitTime: remainingS, minDelay: 5, maxDelay: 5 },
        { VolumeIds: [volumeId] },
      );
      log(`attaching ${volumeId} as ${DEVICE_REQUEST} to ${instanceId}`);
      await ec2.send(
        new AttachVolumeCommand({ VolumeId: volumeId, InstanceId: instanceId, Device: DEVICE_REQUEST }),
      );
      break;
    } catch (err) {
      const name = err instanceof Error ? err.name : "";
      const detachRace = name === "VolumeInUse" || name === "IncorrectState";
      if (detachRace && Date.now() < deadline) {
        log(`  ...attach hit ${name}; re-waiting for ${volumeId} to free up`);
        await sleep(INTERVAL_MS);
        continue;
      }
      throw err;
    }
  }

  await waitForAttachment(ec2, volumeId, instanceId);
  log("attached.");
}

// --- Device resolution -------------------------------------------------------
async function listNvmeDevices(): Promise<string[]> {
  try {
    const entries = await readdir("/dev");
    return entries.filter((e) => /^nvme\d+n1$/.test(e)).map((e) => `/dev/${e}`);
  } catch {
    return [];
  }
}

// Resolve the real Nitro device node for the volume. Nitro remaps /dev/sdf to an
// unpredictable /dev/nvme?n1, so match by volume id / serial. Poll until it appears.
async function resolveDevice(volumeId: string): Promise<string> {
  const serial = volumeId.replace(/-/g, "");
  const byIdLink = `/dev/disk/by-id/nvme-Amazon_Elastic_Block_Store_${serial}`;
  await runQuiet("udevadm", ["settle"]); // best-effort; ignore failure

  const start = Date.now();
  const deadline = start + MAX_WAIT_MS;
  for (;;) {
    // 1) Stable by-id symlink -> resolve to the real /dev/nvme?n1.
    try {
      return await realpath(byIdLink);
    } catch {
      /* not present yet */
    }
    // 2) ebsnvme-id on each NVMe namespace, matching the full volume id.
    for (const dev of await listNvmeDevices()) {
      try {
        const { stdout } = await execFileAsync("/sbin/ebsnvme-id", [dev]);
        if (stdout.includes(volumeId)) return dev;
      } catch {
        /* try next device */
      }
    }
    // 3) lsblk serial match (serial = volume id without dashes).
    try {
      const { stdout } = await execFileAsync("lsblk", ["-dno", "NAME,SERIAL"]);
      for (const line of stdout.split("\n")) {
        const [name, ser] = line.trim().split(/\s+/);
        if (name && ser === serial) return `/dev/${name}`;
      }
    } catch {
      /* ignore and keep polling */
    }
    if (Date.now() >= deadline) {
      const { stdout } = await execFileAsync("lsblk", []).catch(() => ({ stdout: "(lsblk failed)" }));
      errlog(`lsblk:\n${stdout}`);
      throw new Error(`could not resolve NVMe device for ${volumeId} within ${MAX_WAIT_MS / 1000}s`);
    }
    waitBanner(`NVMe device for ${volumeId} to appear`, start, MAX_WAIT_MS);
    await sleep(INTERVAL_MS);
  }
}

// --- Filesystem --------------------------------------------------------------
// Fail-safe toward preserving data: report "has a filesystem" if `blkid -p`
// recognizes a signature OR `file -sL` output does NOT end in ": data". Only when
// BOTH clearly indicate an empty device do we allow a reformat. If `file` cannot
// probe the device at all, assume a filesystem may exist and preserve it.
async function deviceHasFilesystem(dev: string): Promise<boolean> {
  if (await execOk("blkid", ["-p", dev])) return true;
  try {
    const { stdout } = await execFileAsync("file", ["-sL", dev]);
    return !stdout.trimEnd().endsWith(": data");
  } catch {
    return true;
  }
}

async function blkidValue(dev: string, field: "TYPE" | "UUID"): Promise<string> {
  try {
    const { stdout } = await execFileAsync("blkid", ["-s", field, "-o", "value", dev]);
    return stdout.trim();
  } catch {
    return "";
  }
}

interface FilesystemInfo {
  fsType: string;
  uuid: string;
}

// Format ONLY if the device is empty (this is what preserves data), then detect
// the ACTUAL filesystem type + UUID to use for mount and fstab.
async function prepareFilesystem(dev: string): Promise<FilesystemInfo> {
  if (await deviceHasFilesystem(dev)) {
    log(`existing filesystem on ${dev} — preserving data (no mkfs)`);
  } else {
    log(`no filesystem on ${dev} — creating ${DEFAULT_FS_TYPE}`);
    await execFileAsync("mkfs", ["-t", DEFAULT_FS_TYPE, dev]);
  }

  const fsType = await blkidValue(dev, "TYPE");
  const uuid = await blkidValue(dev, "UUID");
  if (fsType === "" || uuid === "") {
    // A signature exists but blkid reports no mountable filesystem — usually a
    // partition table or RAID remnant. The original bash looped here forever;
    // fail loudly with remediation instead of formatting (which would lose data).
    throw new Error(
      `${dev} carries a signature but blkid reports TYPE='${fsType}' UUID='${uuid}'. ` +
        `This looks like a partition table or RAID remnant, not a mountable filesystem. ` +
        `Refusing to mount or reformat to avoid data loss — inspect with 'blkid -p ${dev}'.`,
    );
  }
  return { fsType, uuid };
}

// --- fstab + mount -----------------------------------------------------------
// Always remove every existing line mounting MOUNT_POINT, then append exactly one
// UUID-based entry with nofail. (The original only de-duplicated on the format
// path, so a stale entry could linger when the filesystem already existed.)
async function updateFstab(uuid: string, fsType: string): Promise<void> {
  const desired = `UUID=${uuid} ${MOUNT_POINT} ${fsType} defaults,nofail 0 2`;

  let existing = "";
  try {
    existing = await readFile(FSTAB, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }

  const kept = existing.split("\n").filter((line) => !line.includes(` ${MOUNT_POINT} `));
  while (kept.length > 0 && kept[kept.length - 1] === "") kept.pop();
  kept.push(desired);

  await atomicWrite(FSTAB, kept.join("\n") + "\n");
  log(`fstab entry set: ${desired}`);
}

async function mountAndPermit(): Promise<void> {
  await mkdir(MOUNT_POINT, { recursive: true });
  if (await execOk("mountpoint", ["-q", MOUNT_POINT])) {
    log(`${MOUNT_POINT} already mounted`);
  } else {
    await execFileAsync("mount", [MOUNT_POINT]); // fstab-driven
    log(`mounted ${MOUNT_POINT}`);
  }
  // Sticky bit (1777) rather than 0777: containers share the dir but cannot
  // delete each other's files.
  await execFileAsync("chmod", ["1777", MOUNT_POINT]);
}

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
