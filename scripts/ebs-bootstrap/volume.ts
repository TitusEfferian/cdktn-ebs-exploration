// EC2/EBS control plane: discover the tagged volume and attach it to this instance.

import {
  EC2Client,
  DescribeVolumesCommand,
  AttachVolumeCommand,
  waitUntilVolumeAvailable,
} from "@aws-sdk/client-ec2";
import { DEVICE_REQUEST, INTERVAL_MS, MAX_WAIT_MS } from "./constants";
import { log, logTransient, sleep, waitBanner } from "./utils";

export interface DiscoveredVolume {
  volumeId: string;
  attachedInstanceId?: string;
}

// Find the volume in THIS AZ by its Name tag. Poll until it exists.
export async function discoverVolume(
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

export async function ensureAttached(
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
