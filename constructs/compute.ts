import { Construct } from "constructs";
import { ITerraformDependable } from "cdktn";
import { Autoscaling } from "../.gen/modules/autoscaling";
import { EcsCluster } from "../.gen/modules/ecs_cluster";
import { buildUserDataB64 } from "./user-data";

export interface ComputeProps {
  readonly subnetId: string;
  readonly securityGroupId: string;
  readonly ebsPolicyArn: string;
  readonly clusterName: string;
  readonly capacityProviderName: string;
  readonly volumeName: string;
  // arm64 ECS-optimized AL2023 AMI id (hoisted lookup in the stack, shared
  // with the six slot ASGs so one data source serves every launch template).
  readonly amiId: string;
  // Region for the user-data `aws s3 cp` of the boot bundle.
  readonly region: string;
  // Boot-bundle delivery (from Storage): the S3 location user-data fetches from,
  // and the object the ASG must wait for before the instance boots.
  readonly bootstrapBucketName: string;
  readonly bootstrapObjectKey: string;
  readonly bootstrapObject: ITerraformDependable;
  // Slot capacity providers (name -> ASG arn) registered on the same cluster,
  // alongside the busybox demo's provider. The cluster module's
  // capacityProviders input is a map, so one cluster declares all seven.
  readonly extraCapacityProviders: Record<string, string>;
  readonly tags: Record<string, string>;
}

// Compute layer: the single-instance ASG for the busybox demo, and the ECS
// cluster wired to EC2 capacity providers (the demo's plus one per slot).
export class Compute extends Construct {
  public readonly clusterArn: string;
  public readonly clusterName: string;
  public readonly capacityProviderName: string;
  public readonly asgArn: string;
  public readonly asgName: string;
  // Cluster + ASG as ordering handles for resources that must come up after them.
  public readonly dependables: ITerraformDependable[];
  // Just the cluster module: slot services must order after the capacity-provider
  // association (they reference providers by NAME string, which carries no
  // implicit dependency), but not after the busybox ASG.
  public readonly clusterDependable: ITerraformDependable;

  constructor(scope: Construct, id: string, props: ComputeProps) {
    super(scope, id);

    // The tiny bash bootstrap: install Node, fetch the bundle from S3, run it.
    // Marker replacement + rawString splicing live in ./user-data (shared with
    // the slot ASGs). The busybox instance runs the same boot program with
    // slot "app"/role "app": role-dir prep is a no-op for it, and the shared
    // agent-config lines (task cleanup, IMDS block) are harmless improvements.
    const userDataB64 = buildUserDataB64({
      bootstrapBucketName: props.bootstrapBucketName,
      bootstrapObjectKey: props.bootstrapObjectKey,
      region: props.region,
      volumeTag: props.volumeName,
      clusterName: props.clusterName,
      slotName: "app",
      nodeRole: "app",
    });

    const asg = new Autoscaling(this, "asg", {
      name: props.clusterName,
      imageId: props.amiId,
      instanceType: "t4g.small",
      securityGroups: [props.securityGroupId],
      userData: userDataB64, // module expects base64-encoded user data
      // Upload the bundle to S3 before the instance boots and fetches it.
      dependsOn: [props.bootstrapObject],
      // pin to exactly one instance in one subnet (=> one AZ, = the volume's AZ)
      minSize: 1,
      maxSize: 1,
      desiredCapacity: 1,
      vpcZoneIdentifier: [props.subnetId],
      protectFromScaleIn: true, // required by managed_termination_protection = ENABLED (cluster below)
      // instance role: ECS agent + SSM core + EBS self-attach & boot-bundle read
      createIamInstanceProfile: true,
      iamRoleName: `${props.clusterName}-instance`,
      iamRolePolicies: {
        ecs: "arn:aws:iam::aws:policy/service-role/AmazonEC2ContainerServiceforEC2Role",
        ssm: "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore",
        ebs: props.ebsPolicyArn, // EBS attach/detach + s3:GetObject on the bundle
      },
      // the capacity-provider association expects this tag on ASG instances
      autoscalingGroupTags: { AmazonECSManaged: "true" },
      tags: props.tags,
    });

    // Every capacity provider shares the demo's proven shape: managed scaling
    // (required by managed termination protection) is inert on min=max=1 groups
    // — it can never scale a slot to 0 or above 1.
    const providerFor = (asgArn: string) => ({
      auto_scaling_group_provider: {
        auto_scaling_group_arn: asgArn,
        managed_draining: "ENABLED",
        managed_termination_protection: "ENABLED",
        managed_scaling: {
          status: "ENABLED",
          target_capacity: 100,
          minimum_scaling_step_size: 1,
          maximum_scaling_step_size: 1,
        },
      },
    });

    const cluster = new EcsCluster(this, "cluster", {
      name: props.clusterName,
      capacityProviders: {
        [props.capacityProviderName]: providerFor(asg.autoscalingGroupArnOutput),
        ...Object.fromEntries(
          Object.entries(props.extraCapacityProviders).map(([name, asgArn]) => [
            name,
            providerFor(asgArn),
          ]),
        ),
      },
      // Unchanged from the original demo: ad-hoc RunTask without a strategy
      // lands on the busybox provider — never on a quorum slot's instance.
      defaultCapacityProviderStrategy: {
        [props.capacityProviderName]: {
          weight: 1,
          base: 1,
        },
      },
      tags: props.tags,
    });

    this.clusterArn = cluster.arnOutput;
    this.clusterName = cluster.nameOutput;
    this.capacityProviderName = props.capacityProviderName;
    this.asgArn = asg.autoscalingGroupArnOutput;
    this.asgName = asg.autoscalingGroupNameOutput;
    this.dependables = [cluster, asg];
    this.clusterDependable = cluster;
  }
}
