import * as path from "path";
import { buildSync } from "esbuild";
import { Construct } from "constructs";
import { App, TerraformStack, TerraformOutput, Fn } from "cdktn";
import { AwsProvider } from "@cdktn/provider-aws/lib/provider";
import { Network, Storage, Compute, AppService } from "./constructs";

const region = "ap-northeast-1";

// Bundle the on-instance boot program (scripts/ebs-bootstrap) into a single CJS
// file BEFORE synth, so the TerraformAsset in Storage can read it. cdktn re-runs
// this app on every synth/deploy/diff, so the bundle is always regenerated in
// lockstep; it is then delivered to the instance via S3 (too large for the 16 KB
// user-data limit).
const bootstrapBundlePath = path.join(
  __dirname,
  "scripts",
  "ebs-bootstrap",
  "dist",
  "ebs-bootstrap.cjs",
);
buildSync({
  entryPoints: [path.join(__dirname, "scripts", "ebs-bootstrap", "index.ts")],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs", // lowest-risk for a boot-critical script (no ESM require shims)
  minify: true,
  outfile: bootstrapBundlePath,
});

class MyStack extends TerraformStack {
  constructor(scope: Construct, id: string) {
    super(scope, id);

    new AwsProvider(this, "aws", {
      region,
    });

    const clusterName = "ecs-ebs-demo";
    const serviceName = "app";
    const volumeName = "ecs-ebs-persist"; // Name tag; user-data discovers the volume by this
    // Capacity provider name — AWS forbids aws/ecs/fargate prefixes.
    const capacityProviderName = "ebs-demo-ec2";
    const commonTags = { Environment: "test", ManagedBy: "cdktn" };

    const network = new Network(this, "network", {
      clusterName,
      tags: commonTags,
    });

    const storage = new Storage(this, "storage", {
      // volume lives in azs[0] to match the ASG's single subnet/AZ
      availabilityZone: Fn.element(network.azs, 0),
      clusterName,
      volumeName,
      bootstrapBundlePath,
      tags: commonTags,
    });

    const compute = new Compute(this, "compute", {
      // pin the ASG to one private subnet (=> one AZ, = the volume's AZ)
      subnetId: Fn.element(network.privateSubnets, 0),
      securityGroupId: network.securityGroupId,
      ebsPolicyArn: storage.ebsPolicyArn,
      clusterName,
      capacityProviderName,
      volumeName,
      region,
      bootstrapBucketName: storage.bootstrapBucketName,
      bootstrapObjectKey: storage.bootstrapObjectKey,
      bootstrapObject: storage.bootstrapObject,
      tags: commonTags,
    });

    const appService = new AppService(this, "app-service", {
      serviceName,
      clusterArn: compute.clusterArn,
      capacityProviderName: compute.capacityProviderName,
      tags: commonTags,
      dependsOn: compute.dependables,
    });

    const execHint =
      `aws ecs execute-command --region ${region} --cluster ${clusterName} ` +
      `--container app --interactive --command "/bin/sh" --task <TASK_ID>`;

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
  }
}

const app = new App();
new MyStack(app, "ebs_test");
app.synth();
