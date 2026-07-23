// Register with the ECS cluster (done FIRST, before the slow EBS work).

import { readFile, mkdir } from "node:fs/promises";
import { ECS_CONFIG } from "./constants";
import { atomicWrite, log } from "./utils";

// Upsert ECS_CLUSTER in /etc/ecs/ecs.config: replace every existing ECS_CLUSTER=
// line, or append one if none exists. Never duplicates. Ensures the ECS agent
// reads the right cluster at startup and never falls back to "default".
export async function upsertEcsCluster(clusterName: string): Promise<void> {
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
