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
  readonly amiId: string;
  readonly region: string;
  readonly bootstrapBucketName: string;
  readonly bootstrapObjectKey: string;
  readonly bootstrapObject: ITerraformDependable;
  readonly extraCapacityProviders: Record<string, string>;
  readonly tags: Record<string, string>;
}

export class Compute extends Construct {
  public readonly clusterArn: string;
  public readonly clusterName: string;
  public readonly capacityProviderName: string;
  public readonly asgArn: string;
  public readonly asgName: string;
  public readonly dependables: ITerraformDependable[];
  public readonly clusterDependable: ITerraformDependable;

  constructor(scope: Construct, id: string, props: ComputeProps) {
    super(scope, id);

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
      userData: userDataB64,
      dependsOn: [props.bootstrapObject],
      minSize: 1,
      maxSize: 1,
      desiredCapacity: 1,
      vpcZoneIdentifier: [props.subnetId],
      protectFromScaleIn: true,
      createIamInstanceProfile: true,
      iamRoleName: `${props.clusterName}-instance`,
      iamRolePolicies: {
        ecs: "arn:aws:iam::aws:policy/service-role/AmazonEC2ContainerServiceforEC2Role",
        ssm: "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore",
        ebs: props.ebsPolicyArn,
      },
      autoscalingGroupTags: { AmazonECSManaged: "true" },
      tags: props.tags,
    });

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
