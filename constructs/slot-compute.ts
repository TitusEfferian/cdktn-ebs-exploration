import { Construct } from "constructs";
import { ITerraformDependable } from "cdktn";
import { Autoscaling } from "../.gen/modules/autoscaling";
import { buildUserDataB64 } from "./user-data";
import { slotNodeRole, slotVolumeTag, type Slot } from "./slots";

export interface SlotAsgProps {
  readonly slot: Slot;
  readonly clusterName: string;
  readonly amiId: string;
  readonly subnetId: string;
  readonly securityGroupId: string;
  readonly instanceProfileArn: string;
  readonly region: string;
  readonly bootstrapBucketName: string;
  readonly bootstrapObjectKey: string;
  readonly bootstrapObject: ITerraformDependable;
  readonly tags: Record<string, string>;
}

export class SlotAsg extends Construct {
  public readonly asgArn: string;
  public readonly asgName: string;
  public readonly dependable: ITerraformDependable;

  constructor(scope: Construct, id: string, props: SlotAsgProps) {
    super(scope, id);

    const { slot } = props;
    const name = `${props.clusterName}-${slot.name}`;

    const asg = new Autoscaling(this, "asg", {
      name,
      useNamePrefix: false,
      launchTemplateName: name,
      launchTemplateUseNamePrefix: false,
      updateDefaultVersion: true,
      imageId: props.amiId,
      instanceType: slot.role === "nifi" ? "t4g.medium" : "t4g.small",
      securityGroups: [props.securityGroupId],
      userData: buildUserDataB64({
        bootstrapBucketName: props.bootstrapBucketName,
        bootstrapObjectKey: props.bootstrapObjectKey,
        region: props.region,
        volumeTag: slotVolumeTag(slot),
        clusterName: props.clusterName,
        slotName: slot.name,
        nodeRole: slotNodeRole(slot),
      }),
      dependsOn: [props.bootstrapObject],
      minSize: 1,
      maxSize: 1,
      desiredCapacity: 1,
      vpcZoneIdentifier: [props.subnetId],
      protectFromScaleIn: true,
      healthCheckGracePeriod: 900,
      enableMonitoring: false,
      createIamInstanceProfile: false,
      iamInstanceProfileArn: props.instanceProfileArn,
      autoscalingGroupTags: { AmazonECSManaged: "true" },
      tags: {
        Slot: slot.name,
        EbsSelfAttach: props.clusterName,
        ...props.tags,
      },
    });

    this.asgArn = asg.autoscalingGroupArnOutput;
    this.asgName = asg.autoscalingGroupNameOutput;
    this.dependable = asg;
  }
}
