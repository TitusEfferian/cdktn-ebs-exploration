import { Construct } from "constructs";
import { Fn } from "cdktn";
import { EbsVolume } from "@cdktn/provider-aws/lib/ebs-volume";
import { perSlot, slotVolumeTag, type SlotName } from "./slots";

export interface SlotStorageProps {
  // AZ list token from Network; each volume pins to azs[slot.azIndex] to match
  // its slot's single-subnet ASG.
  readonly azs: string;
  readonly clusterName: string;
  readonly tags: Record<string, string>;
}

// One persistent EBS volume per slot — NOT attached via Terraform (no
// aws_volume_attachment, which would fight the ASGs). Each slot instance's
// user-data finds ITS volume by the globally-unique Name tag + its own AZ and
// attaches it, exactly like the original single-volume demo.
//
// No prevent_destroy: `cdktn destroy` teardown is part of the demo UX. The
// destroy runbook (README-nifi-cluster.md) scales services to 0 first; a
// still-attached volume makes the provider retry DeleteVolume (VolumeInUse)
// for ~10 minutes before failing.
export class SlotStorage extends Construct {
  public readonly volumeIds: Record<SlotName, string>;
  public readonly volumeTags: Record<SlotName, string>;

  constructor(scope: Construct, id: string, props: SlotStorageProps) {
    super(scope, id);

    const volumes = perSlot((slot) => {
      return new EbsVolume(this, `vol_${slot.name.replace(/-/g, "_")}`, {
        availabilityZone: Fn.element(props.azs, slot.azIndex),
        // NiFi holds all repositories (content/provenance can balloon; growth is
        // capped via nifi.properties in the container wrapper); ZK holds tiny
        // snapshots + 64 MiB-preallocated txn logs bounded by autopurge.
        size: slot.role === "nifi" ? 30 : 10,
        type: "gp3", // provider default is gp2 — gp3 must be explicit
        encrypted: true, // default aws/ebs key: attach needs no KMS grants
        tags: {
          Name: slotVolumeTag(slot), // discovery key (unique across all slots)
          // Authorization tag: the shared instance role may attach ONLY volumes
          // (and only to instances) carrying this key — see SlotNodeIam.
          EbsSelfAttach: props.clusterName,
          Slot: slot.name,
          Role: slot.role,
          ...props.tags,
        },
      });
    });

    this.volumeIds = perSlot((slot) => volumes[slot.name].id);
    this.volumeTags = perSlot((slot) => slotVolumeTag(slot));
  }
}
