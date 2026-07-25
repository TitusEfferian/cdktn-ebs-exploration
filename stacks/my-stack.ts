import { Construct } from "constructs";
import { TerraformStack, TerraformOutput, TerraformVariable, Fn } from "cdktn";
import { AwsProvider } from "@cdktn/provider-aws/lib/provider";
import { DataAwsSsmParameter } from "@cdktn/provider-aws/lib/data-aws-ssm-parameter";
import { SsmParameter } from "@cdktn/provider-aws/lib/ssm-parameter";
import {
  Network,
  Storage,
  Compute,
  AppService,
  SlotStorage,
  SlotNodeIam,
  TaskSecurityGroups,
  ServiceDiscovery,
  SlotAsg,
  SlotService,
  SLOTS,
  perSlot,
} from "../constructs";

const region = "ap-northeast-1";

export interface MyStackProps {
  readonly bootstrapBundlePath: string;
}

export class MyStack extends TerraformStack {
  constructor(scope: Construct, id: string, props: MyStackProps) {
    super(scope, id);

    new AwsProvider(this, "aws", {
      region,
    });

    const clusterName = "ecs-ebs-demo";
    const serviceName = "app";
    const volumeName = "ecs-ebs-persist"; // Name tag; user-data discovers the volume by this
    // Capacity provider name — AWS forbids aws/ecs/fargate prefixes.
    const capacityProviderName = "ebs-demo-ec2";
    // Private DNS zone for the NiFi/ZK slots. Frozen: it is baked into
    // ZOO_SERVERS, NiFi cluster addresses, and (later) the TLS cert SANs.
    const namespaceName = "nifi.internal";
    const commonTags = { Environment: "test", ManagedBy: "cdktn" };

    const network = new Network(this, "network", {
      clusterName,
      tags: commonTags,
    });

    // arm64 ECS-optimized AL2023 AMI, shared by ALL seven launch templates
    // (busybox + six slots). This SSM param holds the image-id string directly.
    // insecureValue (not value) so an upstream AMI bump appears as a readable
    // plan diff instead of "(sensitive value)" — it's a public parameter.
    const ami = new DataAwsSsmParameter(this, "ecs_ami", {
      name: "/aws/service/ecs/optimized-ami/amazon-linux-2023/arm64/recommended/image_id",
    });

    const storage = new Storage(this, "storage", {
      // volume lives in azs[0] to match the ASG's single subnet/AZ
      availabilityZone: Fn.element(network.azs, 0),
      clusterName,
      volumeName,
      bootstrapBundlePath: props.bootstrapBundlePath,
      region,
      tags: commonTags,
    });

    // --- NiFi + ZooKeeper slot fleet -----------------------------------------

    // Six per-slot EBS volumes (nifi-1..3, zk-1..3), AZ-pinned to their slots.
    const slotStorage = new SlotStorage(this, "slot-storage", {
      azs: network.azs,
      clusterName,
      tags: commonTags,
    });

    // One shared instance role/profile for the six slot ASGs (attach scope via
    // the EbsSelfAttach tag; reuses the demo's S3 bundle bucket for boot code).
    const slotIam = new SlotNodeIam(this, "slot-iam", {
      clusterName,
      region,
      bootstrapBucketArn: storage.bootstrapBucketArn,
      tags: commonTags,
    });

    // Task-ENI security groups (awsvpc): NiFi web/cluster/lb + ZK client/quorum.
    const taskSgs = new TaskSecurityGroups(this, "task-sgs", {
      vpcId: network.vpcId,
      instanceSecurityGroupId: network.securityGroupId,
      clusterName,
      tags: commonTags,
    });

    // Cloud Map: nifi-1.nifi.internal ... zk-3.nifi.internal (A records).
    const discovery = new ServiceDiscovery(this, "discovery", {
      vpcId: network.vpcId,
      namespaceName,
      tags: commonTags,
    });

    // Six single-instance ASGs, each pinned to its slot's AZ subnet.
    const slotAsgs = perSlot(
      (slot) =>
        new SlotAsg(this, `asg-${slot.name}`, {
          slot,
          clusterName,
          amiId: ami.insecureValue,
          subnetId: Fn.element(network.privateSubnets, slot.azIndex),
          securityGroupId: network.securityGroupId,
          instanceProfileArn: slotIam.instanceProfileArn,
          region,
          bootstrapBucketName: storage.bootstrapBucketName,
          bootstrapObjectKey: storage.bootstrapObjectKey,
          bootstrapObject: storage.bootstrapObject,
          tags: commonTags,
        }),
    );

    const compute = new Compute(this, "compute", {
      // pin the ASG to one private subnet (=> one AZ, = the volume's AZ)
      subnetId: Fn.element(network.privateSubnets, 0),
      securityGroupId: network.securityGroupId,
      ebsPolicyArn: storage.ebsPolicyArn,
      clusterName,
      capacityProviderName,
      volumeName,
      amiId: ami.insecureValue,
      region,
      bootstrapBucketName: storage.bootstrapBucketName,
      bootstrapObjectKey: storage.bootstrapObjectKey,
      bootstrapObject: storage.bootstrapObject,
      // One capacity provider per slot on the shared cluster; each slot service
      // pins its own, which is what fences one task onto one instance.
      extraCapacityProviders: perSlot((slot) => slotAsgs[slot.name].asgArn),
      tags: commonTags,
    });

    const appService = new AppService(this, "app-service", {
      serviceName,
      clusterArn: compute.clusterArn,
      capacityProviderName: compute.capacityProviderName,
      tags: commonTags,
      dependsOn: compute.dependables,
    });

    // nifi.sensitive.props.key: >=12 chars, IDENTICAL on all three NiFi nodes.
    // NOTE: like any Terraform-managed secret, the value lands in the state
    // file — acceptable for this demo. Override per deploy with
    //   cdktn deploy --var nifi_sensitive_props_key=<random >=12 chars>
    // (or TF_VAR_nifi_sensitive_props_key), then rotate by redeploying.
    const sensitiveKey = new TerraformVariable(this, "nifi_sensitive_props_key", {
      type: "string",
      sensitive: true,
      default: "nifi-demo-sensitive-key-rotate-me",
      description: "Shared NiFi sensitive-properties key (>=12 chars, same on all nodes)",
    });
    const sensitiveKeyParam = new SsmParameter(this, "nifi_sensitive_key_param", {
      name: `/${clusterName}/nifi/sensitive-props-key`,
      type: "SecureString", // default aws/ssm key: exec role needs no kms:Decrypt
      value: sensitiveKey.stringValue,
      description: "Injected into NiFi tasks as NIFI_SENSITIVE_PROPS_KEY",
      tags: commonTags,
    });

    // Six ECS services, one per slot. dependsOn the cluster module: services
    // reference capacity providers by NAME string, which carries no implicit
    // dependency on the provider/association resources.
    const slotServices = perSlot(
      (slot) =>
        new SlotService(this, `svc-${slot.name}`, {
          slot,
          clusterArn: compute.clusterArn,
          subnetId: Fn.element(network.privateSubnets, slot.azIndex),
          securityGroupId: slot.role === "nifi" ? taskSgs.nifiTaskSgId : taskSgs.zkTaskSgId,
          registryArn: discovery.serviceArns[slot.name],
          namespaceName,
          sensitiveKeyParameterArn: sensitiveKeyParam.arn,
          tags: commonTags,
          dependsOn: [compute.clusterDependable, slotAsgs[slot.name].dependable],
        }),
    );

    const execHint =
      `aws ecs execute-command --region ${region} --cluster ${clusterName} ` +
      `--container app --interactive --command "/bin/sh" --task <TASK_ID>`;
    const uiPortForwardHint =
      `aws ssm start-session --region ${region} --target <SLOT_INSTANCE_ID> ` +
      `--document-name AWS-StartPortForwardingSessionToRemoteHost ` +
      `--parameters "host=<NIFI_TASK_IP>,portNumber=8080,localPortNumber=8080" ` +
      `# then browse http://localhost:8080/nifi (see README-nifi-cluster.md)`;

    new TerraformOutput(this, "vpc_id", { value: network.vpcId });
    new TerraformOutput(this, "vpc_cidr_block", { value: network.vpcCidrBlock });
    new TerraformOutput(this, "private_subnets", { value: network.privateSubnets });
    new TerraformOutput(this, "public_subnets", { value: network.publicSubnets });
    new TerraformOutput(this, "nat_public_ips", { value: network.natPublicIps });
    new TerraformOutput(this, "igw_id", { value: network.igwId });
    new TerraformOutput(this, "azs", { value: network.azs });
    new TerraformOutput(this, "cluster_name", { value: compute.clusterName });
    new TerraformOutput(this, "service_name", { value: appService.serviceName });
    new TerraformOutput(this, "ebs_volume_id", { value: storage.volumeId });
    new TerraformOutput(this, "asg_name", { value: compute.asgName });
    new TerraformOutput(this, "exec_hint", { value: execHint });
    new TerraformOutput(this, "cloud_map_namespace", { value: discovery.namespaceName });
    new TerraformOutput(this, "slot_volume_ids", { value: slotStorage.volumeIds });
    new TerraformOutput(this, "slot_asg_names", {
      value: perSlot((slot) => slotAsgs[slot.name].asgName),
    });
    new TerraformOutput(this, "slot_service_names", {
      value: SLOTS.map((slot) => slotServices[slot.name].serviceName),
    });
    new TerraformOutput(this, "nifi_sensitive_key_parameter", {
      value: sensitiveKeyParam.name,
    });
    new TerraformOutput(this, "ui_port_forward_hint", { value: uiPortForwardHint });
  }
}
