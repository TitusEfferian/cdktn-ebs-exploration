import { Construct } from "constructs";
import { Fn } from "cdktn";
import { EbsVolume } from "@cdktn/provider-aws/lib/ebs-volume";
import { perSlot, slotVolumeTag, type SlotName } from "./slots";

export interface SlotStorageProps {
  readonly azs: string;
  readonly clusterName: string;
  readonly tags: Record<string, string>;
}

export class SlotStorage extends Construct {
  public readonly volumeIds: Record<SlotName, string>;
  public readonly volumeTags: Record<SlotName, string>;

  constructor(scope: Construct, id: string, props: SlotStorageProps) {
    super(scope, id);

    const volumes = perSlot((slot) => {
      return new EbsVolume(this, `vol_${slot.name.replace(/-/g, "_")}`, {
        availabilityZone: Fn.element(props.azs, slot.azIndex),
        size: slot.role === "nifi" ? 30 : 10,
        type: "gp3",
        encrypted: true,
        tags: {
          Name: slotVolumeTag(slot),
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
