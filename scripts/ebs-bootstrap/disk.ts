// OS-side work: resolve the Nitro device node, format only when the device is
// empty, mount it, and persist the fstab entry.
//
// INVARIANT: this NEVER reformats a device that already carries a filesystem —
// that is what preserves data across instance replacement in the EBS demo.

import { readFile, mkdir, realpath, readdir } from "node:fs/promises";
import { DEFAULT_FS_TYPE, FSTAB, INTERVAL_MS, MAX_WAIT_MS, MOUNT_POINT } from "./constants";
import { atomicWrite, errlog, execFileAsync, execOk, log, runQuiet, sleep, waitBanner } from "./utils";

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
export async function resolveDevice(volumeId: string): Promise<string> {
  const serial = volumeId.replace(/-/g, "");
  const byIdLink = `/dev/disk/by-id/nvme-Amazon_Elastic_Block_Store_${serial}`;
  await runQuiet("udevadm", ["settle"]); // best-effort; ignore failure

  const start = Date.now();
  const deadline = start + MAX_WAIT_MS;
  while (true) {
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

export interface FilesystemInfo {
  fsType: string;
  uuid: string;
}

// Format ONLY if the device is empty (this is what preserves data), then detect
// the ACTUAL filesystem type + UUID to use for mount and fstab.
export async function prepareFilesystem(dev: string): Promise<FilesystemInfo> {
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

// Always remove every existing line mounting MOUNT_POINT, then append exactly one
// UUID-based entry with nofail. (The original only de-duplicated on the format
// path, so a stale entry could linger when the filesystem already existed.)
export async function updateFstab(uuid: string, fsType: string): Promise<void> {
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

export async function mountAndPermit(): Promise<void> {
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
