import * as fs from "fs";
import * as path from "path";
import { Construct } from "constructs";
import { ITerraformDependable } from "cdktn";
import { DataAwsSsmParameter } from "@cdktn/provider-aws/lib/data-aws-ssm-parameter";
import { Autoscaling } from "../.gen/modules/autoscaling";
import { EcsCluster } from "../.gen/modules/ecs_cluster";

export interface ComputeProps {
  readonly subnetId: string;
  readonly securityGroupId: string;
  readonly ebsPolicyArn: string;
  readonly clusterName: string;
  readonly capacityProviderName: string;
  readonly volumeName: string;
  readonly tags: Record<string, string>;
}

// Compute layer: the ECS-optimized AMI lookup, the single-instance ASG, and the
// ECS cluster wired to an EC2 capacity provider backed by that ASG.
export class Compute extends Construct {
  public readonly clusterArn: string;
  public readonly clusterName: string;
  public readonly capacityProviderName: string;
  public readonly asgArn: string;
  public readonly asgName: string;
  // Cluster + ASG as ordering handles for resources that must come up after them.
  public readonly dependables: ITerraformDependable[];

  constructor(scope: Construct, id: string, props: ComputeProps) {
    super(scope, id);

    // arm64 ECS-optimized AL2023 AMI (matches the t4g.small Graviton instance).
    // This SSM param holds the image-id string directly, so .value is the AMI id.
    const ami = new DataAwsSsmParameter(this, "ecs_ami", {
      name: "/aws/service/ecs/optimized-ami/amazon-linux-2023/arm64/recommended/image_id",
    });

    const userDataScript = fs
      .readFileSync(path.join(__dirname, "..", "scripts", "user-data.sh"), "utf8")
      .replace(/<VOLUME_TAG>/g, props.volumeName)
      .replace(/<CLUSTER_NAME>/g, props.clusterName);
    const userDataB64 = Buffer.from(userDataScript, "utf8").toString("base64");

    const asg = new Autoscaling(this, "asg", {
      name: props.clusterName,
      imageId: ami.value,
      instanceType: "t4g.small",
      securityGroups: [props.securityGroupId],
      userData: userDataB64, // module expects base64-encoded user data
      // pin to exactly one instance in one subnet (=> one AZ, = the volume's AZ)
      minSize: 1,
      maxSize: 1,
      desiredCapacity: 1,
      vpcZoneIdentifier: [props.subnetId],
      protectFromScaleIn: true, // required by managed_termination_protection = ENABLED (cluster below)
      // instance role: ECS agent + SSM core + EBS self-attach
      createIamInstanceProfile: true,
      iamRoleName: `${props.clusterName}-instance`,
      iamRolePolicies: {
        ecs: "arn:aws:iam::aws:policy/service-role/AmazonEC2ContainerServiceforEC2Role",
        ssm: "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore",
        ebs: props.ebsPolicyArn,
      },
      // the capacity-provider association expects this tag on ASG instances
      autoscalingGroupTags: { AmazonECSManaged: "true" },
      tags: props.tags,
    });

    const cluster = new EcsCluster(this, "cluster", {
      name: props.clusterName,
      capacityProviders: {
        [props.capacityProviderName]: {
          auto_scaling_group_provider: {
            auto_scaling_group_arn: asg.autoscalingGroupArnOutput,
            managed_draining: "ENABLED",
            managed_termination_protection: "ENABLED",
            managed_scaling: {
              status: "ENABLED",
              target_capacity: 100,
              minimum_scaling_step_size: 1,
              maximum_scaling_step_size: 1,
            },
          },
        },
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
  }
}
