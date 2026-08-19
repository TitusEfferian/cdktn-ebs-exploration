// ECS agent configuration — written LAST, after the volume is mounted, plus a
// systemd guard so the agent can never start (or restart) without the mount.
//
// Ordering rationale: the ECS agent's unit starts after cloud-final (user
// data), but writing ECS_CLUSTER only after the mount succeeds converts any
// ordering violation into a LOUD failure — an agent that somehow started early
// would join the "default" cluster, where our services never place tasks, so a
// task can never bind-mount an unmounted /mnt/ebs (silent data split-brain).

import { readFile, mkdir } from "node:fs/promises";
import { ECS_CONFIG, ECS_DROPIN_DIR, ECS_DROPIN_FILE, MOUNT_POINT } from "./constants";
import { atomicWrite, execFileAsync, log } from "./utils";

// Upsert key=value entries in /etc/ecs/ecs.config: replace EVERY existing line
// for a key (never duplicates), append the rest. Preserves unrelated lines.
export async function upsertEcsConfig(entries: Record<string, string>): Promise<void> {
  await mkdir("/etc/ecs", { recursive: true });

  let existing = "";
  try {
    existing = await readFile(ECS_CONFIG, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }

  const body = existing.endsWith("\n") ? existing.slice(0, -1) : existing;
  const lines = existing.length > 0 ? body.split("\n") : [];
  const replaced = new Set<string>();
  const out = lines.map((line) => {
    for (const [key, value] of Object.entries(entries)) {
      if (line.startsWith(`${key}=`)) {
        replaced.add(key);
        return `${key}=${value}`;
      }
    }
    return line;
  });
  for (const [key, value] of Object.entries(entries)) {
    if (!replaced.has(key)) out.push(`${key}=${value}`);
  }

  await atomicWrite(ECS_CONFIG, out.join("\n") + "\n");
  log(`ecs.config set: ${Object.keys(entries).join(", ")}`);
}

// Drop-in: ecs.service refuses to start while /mnt/ebs is not a mountpoint
// (ExecStartPre failure + the unit's Restart=on-failure retry until it is).
// Installed BEFORE ecs.config is written, so there is no window where the
// agent is configured but unguarded. Also keeps the agent down if the volume
// ever disappears mid-life and the unit restarts.
export async function installEcsMountGuard(): Promise<void> {
  await mkdir(ECS_DROPIN_DIR, { recursive: true });
  await atomicWrite(
    ECS_DROPIN_FILE,
    `[Service]\nExecStartPre=/usr/bin/findmnt --mountpoint ${MOUNT_POINT}\n`,
  );
  await execFileAsync("systemctl", ["daemon-reload"]);
  log(`installed ${ECS_DROPIN_FILE} (agent start requires ${MOUNT_POINT} mounted)`);
}
