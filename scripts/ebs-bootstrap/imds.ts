// Instance identity via the EC2 Instance Metadata Service.

import { MetadataService } from "@aws-sdk/ec2-metadata-service";
import { IMDS_WAIT_MS, INTERVAL_MS } from "./constants";
import { sleep, waitBanner } from "./utils";

export interface InstanceIdentity {
  instanceId: string;
  az: string;
  region: string;
}

// MetadataService handles the IMDSv2 token automatically. Poll up to IMDS_WAIT_MS
// for the first success (the metadata endpoint can lag early in boot).
export async function getInstanceIdentity(): Promise<InstanceIdentity> {
  const meta = new MetadataService({});
  const start = Date.now();
  const deadline = start + IMDS_WAIT_MS;
  while (true) {
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
