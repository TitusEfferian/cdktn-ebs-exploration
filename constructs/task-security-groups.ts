import { Construct } from "constructs";
import { SecurityGroup } from "@cdktn/provider-aws/lib/security-group";
import { VpcSecurityGroupIngressRule } from "@cdktn/provider-aws/lib/vpc-security-group-ingress-rule";
import { VpcSecurityGroupEgressRule } from "@cdktn/provider-aws/lib/vpc-security-group-egress-rule";

export interface TaskSecurityGroupsProps {
  readonly vpcId: string;
  readonly instanceSecurityGroupId: string;
  readonly clusterName: string;
  readonly tags: Record<string, string>;
}

export class TaskSecurityGroups extends Construct {
  public readonly nifiTaskSgId: string;
  public readonly zkTaskSgId: string;

  constructor(scope: Construct, id: string, props: TaskSecurityGroupsProps) {
    super(scope, id);

    const nifiSg = new SecurityGroup(this, "nifi_task_sg", {
      name: `${props.clusterName}-nifi-task`,
      description: "NiFi task ENIs (web + cluster + load-balance)",
      vpcId: props.vpcId,
      tags: props.tags,
    });
    const zkSg = new SecurityGroup(this, "zk_task_sg", {
      name: `${props.clusterName}-zk-task`,
      description: "ZooKeeper task ENIs (client + quorum + election)",
      vpcId: props.vpcId,
      tags: props.tags,
    });

    new VpcSecurityGroupIngressRule(this, "nifi_web_from_instances", {
      securityGroupId: nifiSg.id,
      description: "NiFi HTTPS UI/API via SSM port-forward from slot instances",
      ipProtocol: "tcp",
      fromPort: 8443,
      toPort: 8443,
      referencedSecurityGroupId: props.instanceSecurityGroupId,
    });
    new VpcSecurityGroupIngressRule(this, "nifi_web_self", {
      securityGroupId: nifiSg.id,
      description: "node-to-node REST replication (HTTPS web port)",
      ipProtocol: "tcp",
      fromPort: 8443,
      toPort: 8443,
      referencedSecurityGroupId: nifiSg.id,
    });
    new VpcSecurityGroupIngressRule(this, "nifi_cluster_self", {
      securityGroupId: nifiSg.id,
      description: "cluster protocol (nifi.cluster.node.protocol.port)",
      ipProtocol: "tcp",
      fromPort: 11443,
      toPort: 11443,
      referencedSecurityGroupId: nifiSg.id,
    });
    new VpcSecurityGroupIngressRule(this, "nifi_lb_self", {
      securityGroupId: nifiSg.id,
      description: "load-balanced connections (6342)",
      ipProtocol: "tcp",
      fromPort: 6342,
      toPort: 6342,
      referencedSecurityGroupId: nifiSg.id,
    });
    new VpcSecurityGroupEgressRule(this, "nifi_egress_all", {
      securityGroupId: nifiSg.id,
      description: "all outbound (ZK 2181, peers, NAT egress)",
      ipProtocol: "-1",
      cidrIpv4: "0.0.0.0/0",
    });

    new VpcSecurityGroupIngressRule(this, "zk_client_from_nifi", {
      securityGroupId: zkSg.id,
      description: "NiFi ZK client sessions",
      ipProtocol: "tcp",
      fromPort: 2181,
      toPort: 2181,
      referencedSecurityGroupId: nifiSg.id,
    });
    new VpcSecurityGroupIngressRule(this, "zk_client_from_instances", {
      securityGroupId: zkSg.id,
      description: "host-side debug (zkCli / 4lw via port-forward)",
      ipProtocol: "tcp",
      fromPort: 2181,
      toPort: 2181,
      referencedSecurityGroupId: props.instanceSecurityGroupId,
    });
    new VpcSecurityGroupIngressRule(this, "zk_quorum_self", {
      securityGroupId: zkSg.id,
      description: "quorum (follower to leader)",
      ipProtocol: "tcp",
      fromPort: 2888,
      toPort: 2888,
      referencedSecurityGroupId: zkSg.id,
    });
    new VpcSecurityGroupIngressRule(this, "zk_election_self", {
      securityGroupId: zkSg.id,
      description: "leader election",
      ipProtocol: "tcp",
      fromPort: 3888,
      toPort: 3888,
      referencedSecurityGroupId: zkSg.id,
    });
    new VpcSecurityGroupEgressRule(this, "zk_egress_all", {
      securityGroupId: zkSg.id,
      description: "all outbound (peers, NAT egress)",
      ipProtocol: "-1",
      cidrIpv4: "0.0.0.0/0",
    });

    this.nifiTaskSgId = nifiSg.id;
    this.zkTaskSgId = zkSg.id;
  }
}
