import * as fs from "fs";
import * as path from "path";
import { Construct } from "constructs";
import { Fn, ITerraformDependable } from "cdktn";
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
  // Region for the user-data `aws s3 cp` of the boot bundle.
  readonly region: string;
  // Boot-bundle delivery (from Storage): the S3 location user-data fetches from,
  // and the object the ASG must wait for before the instance boots.
  readonly bootstrapBucketName: string;
  readonly bootstrapObjectKey: string;
  readonly bootstrapObject: ITerraformDependable;
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

    // The tiny bash bootstrap: install Node, fetch the bundle from S3, run it.
    // The generated bucket name is a Terraform token, so base64 must happen in
    // Terraform — a Buffer at synth would encode the unresolved token. But the
    // script also contains literal double quotes and bash ${...}, which
    // Fn.base64encode rejects on a plain string. Fn.join + Fn.rawString keep the
    // literal script exact (quotes and all) while splicing the bucket name in as
    // a real reference; rawString escapes bash ${VAR} to $${VAR} so Terraform
    // leaves it for the shell.
    const scriptTemplate = fs
      .readFileSync(path.join(__dirname, "..", "scripts", "bootstrap.sh"), "utf8")
      .replace(/<BUNDLE_KEY>/g, props.bootstrapObjectKey)
      .replace(/<REGION>/g, props.region)
      .replace(/<VOLUME_TAG>/g, props.volumeName)
      .replace(/<CLUSTER_NAME>/g, props.clusterName);
    // <BUNDLE_BUCKET> must appear exactly once; splice the bucket-name token
    // between the surrounding literal halves. (If bootstrap.sh ever gains a literal
    // Terraform `%{` directive — e.g. from `printf`/`curl -w` — pre-escape it to
    // `%%{`; cdktn's rawString escapes `${` but not `%{`.)
    const parts = scriptTemplate.split("<BUNDLE_BUCKET>");
    if (parts.length !== 2) {
      throw new Error(
        `expected exactly one <BUNDLE_BUCKET> marker in bootstrap.sh, found ${parts.length - 1}`,
      );
    }
    const [scriptHead, scriptTail] = parts;
    const userDataB64 = Fn.base64encode(
      Fn.join("", [Fn.rawString(scriptHead), props.bootstrapBucketName, Fn.rawString(scriptTail)]),
    );

    const asg = new Autoscaling(this, "asg", {
      name: props.clusterName,
      imageId: ami.value,
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
