import { Construct } from "constructs";
import { Fn } from "cdktn";
import { SecurityGroup } from "@cdktn/provider-aws/lib/security-group";
import { Vpc } from "../.gen/modules/vpc";

export interface NetworkProps {
  readonly clusterName: string;
  readonly tags: Record<string, string>;
}

// Network layer: the VPC (public/private subnets across 3 AZs, single NAT, IGW)
// plus the egress-only instance security group.
export class Network extends Construct {
  public readonly vpcId: string;
  public readonly vpcCidrBlock: string;
  public readonly privateSubnets: string;
  public readonly publicSubnets: string;
  public readonly natPublicIps: string;
  public readonly igwId: string;
  public readonly azs: string;
  public readonly securityGroupId: string;

  constructor(scope: Construct, id: string, props: NetworkProps) {
    super(scope, id);

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

    // Instance security group: egress-all (outbound to ECS/ECR/ssmmessages),
    // no ingress (Exec is outbound via SSM; no SSH needed).
    const instanceSg = new SecurityGroup(this, "instance_sg", {
      name: `${props.clusterName}-instance`,
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
      tags: props.tags,
    });

    this.vpcId = vpc.vpcIdOutput;
    this.vpcCidrBlock = vpc.vpcCidrBlockOutput;
    this.privateSubnets = vpc.privateSubnetsOutput;
    this.publicSubnets = vpc.publicSubnetsOutput;
    this.natPublicIps = vpc.natPublicIpsOutput;
    this.igwId = vpc.igwIdOutput;
    this.azs = vpc.azsOutput;
    this.securityGroupId = instanceSg.id;
  }
}
