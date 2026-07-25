import { Construct } from "constructs";
import { ITerraformDependable } from "cdktn";
import { Autoscaling } from "../.gen/modules/autoscaling";
import { buildUserDataB64 } from "./user-data";
import { slotNodeRole, slotVolumeTag, type Slot } from "./slots";

export interface SlotAsgProps {
  readonly slot: Slot;
  readonly clusterName: string;
  // Shared arm64 ECS-optimized AL2023 AMI id (hoisted lookup in the stack).
  readonly amiId: string;
  // The slot's single private subnet (=> its AZ, = its volume's AZ).
  readonly subnetId: string;
  readonly securityGroupId: string;
  // Shared instance profile from SlotNodeIam (one role for all six slots).
  readonly instanceProfileArn: string;
  readonly region: string;
  readonly bootstrapBucketName: string;
  readonly bootstrapObjectKey: string;
  readonly bootstrapObject: ITerraformDependable;
  readonly tags: Record<string, string>;
}

// One single-instance ASG per slot, AZ-pinned via its one subnet. The paired
// capacity provider (registered on the cluster in Compute) is what fences the
// slot's ECS service onto exactly this instance.
export class SlotAsg extends Construct {
  public readonly asgArn: string;
  public readonly asgName: string;
  public readonly dependable: ITerraformDependable;

  constructor(scope: Construct, id: string, props: SlotAsgProps) {
    super(scope, id);

    const { slot } = props;
    const name = `${props.clusterName}-${slot.name}`;

    const asg = new Autoscaling(this, "asg", {
      // Stable names (no hash suffix): the runbook addresses ASGs per slot.
      name,
      useNamePrefix: false,
      launchTemplateName: name,
      launchTemplateUseNamePrefix: false,
      updateDefaultVersion: true,
      imageId: props.amiId,
      // NiFi is JVM-heavy (1g heap + NARs); ZK is light (512m heap).
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
      // Upload the bundle to S3 before the instance boots and fetches it.
      dependsOn: [props.bootstrapObject],
      // exactly one instance in one subnet (=> one AZ, = the slot volume's AZ)
      minSize: 1,
      maxSize: 1,
      desiredCapacity: 1,
      vpcZoneIdentifier: [props.subnetId],
      protectFromScaleIn: true, // required by managed_termination_protection = ENABLED
      // EC2-type health checks can't cull an instance for slow user-data (it
      // stays `running`), but set the grace above the worst-case volume-wait
      // budget anyway so adding ELB/EBS checks later can never race boot.
      healthCheckGracePeriod: 900,
      // Basic (free, 5-min) monitoring; module default is detailed (billed).
      // Status-check metrics stay 1-minute either way, so ASG health is unaffected.
      enableMonitoring: false,
      // One shared role/profile for all six slots (see SlotNodeIam for scope).
      createIamInstanceProfile: false,
      iamInstanceProfileArn: props.instanceProfileArn,
      // the capacity-provider association expects this tag on ASG instances
      autoscalingGroupTags: { AmazonECSManaged: "true" },
      tags: {
        // Propagated to the instance at launch: Slot for operator queries,
        // EbsSelfAttach to satisfy the instance-side attach condition.
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
