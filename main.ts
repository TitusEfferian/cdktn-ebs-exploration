import * as fs from "fs";
import * as path from "path";
import { Construct } from "constructs";
import { App, TerraformStack, TerraformOutput, Fn } from "cdktn";

import { AwsProvider } from "@cdktn/provider-aws/lib/provider";
import { DataAwsSsmParameter } from "@cdktn/provider-aws/lib/data-aws-ssm-parameter";
import { EbsVolume } from "@cdktn/provider-aws/lib/ebs-volume";
import { IamPolicy } from "@cdktn/provider-aws/lib/iam-policy";
import { SecurityGroup } from "@cdktn/provider-aws/lib/security-group";
import { Vpc } from "./.gen/modules/vpc";
import { Autoscaling } from "./.gen/modules/autoscaling";
import { EcsCluster } from "./.gen/modules/ecs_cluster";
import { EcsService } from "./.gen/modules/ecs_service";

class MyStack extends TerraformStack {
  constructor(scope: Construct, id: string) {
    super(scope, id);

    new AwsProvider(this, "aws", {
      region: "ap-northeast-1",
    });

    const azs = ["ap-northeast-1a", "ap-northeast-1c", "ap-northeast-1d"];
    const vpcCidr = "10.0.0.0/16";

    const vpc = new Vpc(this, "vpc", {
      name: "ebs-test-vpc",
      cidr: vpcCidr,
      azs,
      // /24 subnets derived from the VPC /16, one per AZ. cidrsubnet(prefix, 8, n)
      // sets the third octet to n: private => 10.0.1-3.0/24, public => 10.0.101-103.0/24.
      privateSubnets: azs.map((_, i) => Fn.cidrsubnet(vpcCidr, 8, i + 1)),
      publicSubnets: azs.map((_, i) => Fn.cidrsubnet(vpcCidr, 8, i + 101)),
      enableNatGateway: true,
      singleNatGateway: true,
      createIgw: true,
      enableDnsHostnames: true,
      enableDnsSupport: true,
      tags: {
        Environment: "test",
        ManagedBy: "cdktn",
      },
    });

    new TerraformOutput(this, "vpc_id", { value: vpc.vpcIdOutput });
    new TerraformOutput(this, "vpc_cidr_block", { value: vpc.vpcCidrBlockOutput });
    new TerraformOutput(this, "private_subnets", { value: vpc.privateSubnetsOutput });
    new TerraformOutput(this, "public_subnets", { value: vpc.publicSubnetsOutput });
    new TerraformOutput(this, "nat_public_ips", { value: vpc.natPublicIpsOutput });
    new TerraformOutput(this, "igw_id", { value: vpc.igwIdOutput });
    new TerraformOutput(this, "azs", { value: vpc.azsOutput });

    // =====================================================================
    // ECS-on-EC2 + standalone-EBS persistence demo
    // =====================================================================
    // Everything AZ-scoped is pinned to the first VPC AZ (ap-northeast-1a):
    // the ASG launches into publicSubnets[0] and the EBS volume lives in
    // azs[0], so a replacement instance lands in the same AZ and re-attaches
    // the same volume. See scripts/user-data.sh + README-ebs-demo.md.
    const clusterName = "ecs-ebs-demo";
    const serviceName = "app";
    const volumeName = "ecs-ebs-persist"; // Name tag; user-data discovers the volume by this
    // NOTE: capacity provider names may NOT be prefixed with "aws", "ecs", or
    // "fargate" (AWS restriction), so this is NOT derived from clusterName.
    const capacityProviderName = "ebs-demo-ec2";
    const commonTags = { Environment: "test", ManagedBy: "cdktn" };

    // arm64 ECS-optimized AL2023 AMI (matches the t4g.small Graviton instance).
    // This SSM param holds the image-id string directly, so .value is the AMI id.
    const ami = new DataAwsSsmParameter(this, "ecs_ami", {
      name: "/aws/service/ecs/optimized-ami/amazon-linux-2023/arm64/recommended/image_id",
    });

    // Standalone EBS volume — NOT attached via Terraform (no aws_volume_attachment,
    // which would fight the ASG). The instance's user-data finds it by tag+AZ and
    // attaches it. Lives in azs[0] to match the ASG's subnet AZ.
    const ebsVolume = new EbsVolume(this, "ebs_persist", {
      availabilityZone: Fn.element(vpc.azsOutput, 0),
      size: 5,
      type: "gp3",
      encrypted: true,
      tags: { Name: volumeName, ...commonTags },
    });

    // Policy letting the instance self-attach the volume (fed to the ASG role).
    // Describe* cannot be resource-scoped; Attach/Detach on "*" is fine for a demo.
    const ebsPolicy = new IamPolicy(this, "ebs_attach_policy", {
      name: `${clusterName}-ebs-self-attach`,
      policy: JSON.stringify({
        Version: "2012-10-17",
        Statement: [
          {
            Sid: "Describe",
            Effect: "Allow",
            Action: ["ec2:DescribeVolumes", "ec2:DescribeInstances"],
            Resource: "*",
          },
          {
            Sid: "AttachDetach",
            Effect: "Allow",
            Action: ["ec2:AttachVolume", "ec2:DetachVolume"],
            Resource: "*",
          },
        ],
      }),
      tags: commonTags,
    });

    // Instance security group: egress-all (outbound to ECS/ECR/ssmmessages),
    // no ingress (Exec is outbound via SSM; no SSH needed).
    const instanceSg = new SecurityGroup(this, "instance_sg", {
      name: `${clusterName}-instance`,
      vpcId: vpc.vpcIdOutput,
      egress: [
        {
          fromPort: 0,
          toPort: 0,
          protocol: "-1",
          cidrBlocks: ["0.0.0.0/0"],
          description: "all outbound",
        },
      ],
      tags: commonTags,
    });

    // user-data: read the script, substitute the synth-time constants, then
    // base64-encode in Node. Encoding here (rather than via Fn.base64encode)
    // keeps Terraform from trying to interpret the script's bash ${...} as HCL
    // interpolations, and sidesteps the double-quote validation on Fn args.
    const userDataScript = fs
      .readFileSync(path.join(__dirname, "scripts", "user-data.sh"), "utf8")
      .replace(/<VOLUME_TAG>/g, volumeName)
      .replace(/<CLUSTER_NAME>/g, clusterName);
    const userDataB64 = Buffer.from(userDataScript, "utf8").toString("base64");

    // ASG + launch template + instance profile (terraform-aws-modules/autoscaling).
    const asg = new Autoscaling(this, "asg", {
      name: clusterName,
      // launch template
      imageId: ami.value,
      instanceType: "t4g.small",
      securityGroups: [instanceSg.id],
      userData: userDataB64, // module expects base64-encoded user data
      // pin to exactly one instance in one subnet (=> one AZ, = the volume's AZ)
      minSize: 1,
      maxSize: 1,
      desiredCapacity: 1,
      vpcZoneIdentifier: [Fn.element(vpc.publicSubnetsOutput, 0)],
      protectFromScaleIn: false,
      // the capacity provider's managed_scaling drives desired capacity; don't
      // let Terraform revert it on subsequent plans.
      ignoreDesiredCapacityChanges: true,
      // instance role: ECS agent + SSM core + EBS self-attach
      createIamInstanceProfile: true,
      iamRoleName: `${clusterName}-instance`,
      iamRolePolicies: {
        ecs: "arn:aws:iam::aws:policy/service-role/AmazonEC2ContainerServiceforEC2Role",
        ssm: "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore",
        ebs: ebsPolicy.arn,
      },
      // ECS capacity-provider association expects this tag on ASG instances
      autoscalingGroupTags: { AmazonECSManaged: "true" },
      tags: commonTags,
    });

    // ECS cluster + EC2 capacity provider backed by the ASG above.
    // capacityProviders / defaultCapacityProviderStrategy are `any`-typed module
    // inputs, so their nested keys are emitted verbatim => Terraform snake_case.
    // The capacity provider's name defaults to its map key (capacityProviderName).
    const cluster = new EcsCluster(this, "cluster", {
      name: clusterName,
      capacityProviders: {
        [capacityProviderName]: {
          auto_scaling_group_provider: {
            auto_scaling_group_arn: asg.autoscalingGroupArnOutput,
            // DISABLED so the demo can terminate the instance directly; if this
            // were ENABLED the ASG would need protect_from_scale_in = true.
            managed_termination_protection: "DISABLED",
            managed_scaling: {
              status: "ENABLED",
              target_capacity: 100,
            },
          },
        },
      },
      // Cluster default strategy references the provider above by name (= key).
      defaultCapacityProviderStrategy: {
        [capacityProviderName]: {
          weight: 1,
          base: 1,
        },
      },
      tags: commonTags,
    });

    // ECS service: busybox task, bridge networking, host bind-mount of the EBS
    // mount point into /data, Exec enabled. When enableExecuteCommand is true
    // the module automatically grants the TASKS role the ssmmessages:* actions
    // that execute-command requires, so no extra task role is needed here.
    const service = new EcsService(this, "service", {
      // Wait for the whole cluster module (incl. the capacity-provider
      // association) before placing tasks. clusterArn alone only links the
      // cluster resource, not the aws_ecs_cluster_capacity_providers association.
      dependsOn: [cluster],
      name: serviceName,
      clusterArn: cluster.arnOutput,
      requiresCompatibilities: ["EC2"],
      // EC2 placement via the capacity provider (do NOT also set launchType).
      // `capacity_provider` is a required field on each strategy entry.
      capacityProviderStrategy: {
        [capacityProviderName]: {
          capacity_provider: capacityProviderName,
          weight: 1,
          base: 1,
        },
      },
      networkMode: "bridge",
      createSecurityGroup: false, // bridge mode => no task ENI/SG
      cpu: 256,
      memory: 512,
      enableExecuteCommand: true,
      // host bind-mount: /mnt/ebs (host, = EBS mount point) -> /data (container).
      // Volume name defaults to the map key "data".
      volume: {
        data: {
          host_path: "/mnt/ebs",
        },
      },
      // container_definitions mirror the AWS container-definition document: the
      // ECS fields are camelCase (mountPoints/sourceVolume/linuxParameters/...);
      // only the module-specific toggles are snake_case.
      containerDefinitions: {
        app: {
          image: "busybox:latest",
          essential: true,
          cpu: 256,
          memory: 512,
          // busybox has no bash and no `sleep infinity`; keep it alive with a loop
          command: ["sh", "-c", "while true; do sleep 3600; done"],
          mountPoints: [
            {
              sourceVolume: "data", // must equal the volume key above
              containerPath: "/data",
              readOnly: false,
            },
          ],
          linuxParameters: {
            initProcessEnabled: true, // required for ECS Exec
          },
          readonlyRootFilesystem: false, // Exec injects the SSM agent into the FS
        },
      },
      tags: commonTags,
    });

    const execHint =
      `aws ecs execute-command --region ap-northeast-1 --cluster ${clusterName} ` +
      `--container app --interactive --command "/bin/sh" --task <TASK_ID>`;

    new TerraformOutput(this, "cluster_name", { value: cluster.nameOutput });
    new TerraformOutput(this, "service_name", { value: service.nameOutput });
    new TerraformOutput(this, "ebs_volume_id", { value: ebsVolume.id });
    new TerraformOutput(this, "asg_name", { value: asg.autoscalingGroupNameOutput });
    new TerraformOutput(this, "exec_hint", { value: execHint });
  }
}

const app = new App();
new MyStack(app, "ebs_test");
app.synth();
