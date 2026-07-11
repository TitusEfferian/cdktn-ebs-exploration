import { Construct } from "constructs";
import { App, TerraformStack, TerraformOutput } from "cdktn";

import { AwsProvider } from "@cdktn/provider-aws/lib/provider";
import { Vpc } from "./.gen/modules/vpc";

class MyStack extends TerraformStack {
  constructor(scope: Construct, id: string) {
    super(scope, id);

    new AwsProvider(this, "aws", {
      region: "ap-northeast-1",
    });

    const azs = ["ap-northeast-1a", "ap-northeast-1c", "ap-northeast-1d"];

    const vpc = new Vpc(this, "vpc", {
      name: "ebs-test-vpc",
      cidr: "10.0.0.0/16",
      azs,
      privateSubnets: ["10.0.1.0/24", "10.0.2.0/24", "10.0.3.0/24"],
      publicSubnets: ["10.0.101.0/24", "10.0.102.0/24", "10.0.103.0/24"],
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
  }
}

const app = new App();
new MyStack(app, "ebs_test");
app.synth();
