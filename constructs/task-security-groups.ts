import { Construct } from "constructs";
import { SecurityGroup } from "@cdktn/provider-aws/lib/security-group";
import { VpcSecurityGroupIngressRule } from "@cdktn/provider-aws/lib/vpc-security-group-ingress-rule";
import { VpcSecurityGroupEgressRule } from "@cdktn/provider-aws/lib/vpc-security-group-egress-rule";

export interface TaskSecurityGroupsProps {
  readonly vpcId: string;
  // Container-instance SG: source of the SSM port-forward path (the session
  // terminates on the slot instance, so forwarded traffic to a task ENI
  // originates from the instance's ENI/SG).
  readonly instanceSecurityGroupId: string;
  readonly clusterName: string;
  readonly tags: Record<string, string>;
}

// Task-ENI security groups for the awsvpc services. Standalone v2 rule
// resources (one rule each, referenced_security_group_id for SG-to-SG) are the
// current provider guidance and avoid dependency cycles between the SGs;
// Terraform strips AWS's default allow-all egress, so each SG declares its own.
// DNS to the VPC resolver bypasses SGs entirely — no rules needed for it.
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

    // --- NiFi ingress ---------------------------------------------------------
    new VpcSecurityGroupIngressRule(this, "nifi_web_from_instances", {
      securityGroupId: nifiSg.id,
      description: "NiFi UI/API via SSM port-forward from slot instances",
      ipProtocol: "tcp",
      fromPort: 8080,
      toPort: 8080,
      referencedSecurityGroupId: props.instanceSecurityGroupId,
    });
    // Cluster REST request replication travels node-to-node over the WEB port,
    // in addition to the cluster-protocol and load-balance ports.
    new VpcSecurityGroupIngressRule(this, "nifi_web_self", {
      securityGroupId: nifiSg.id,
      description: "node-to-node REST replication (web port)",
      ipProtocol: "tcp",
      fromPort: 8080,
      toPort: 8080,
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
      ipProtocol: "-1", // all protocols => from/to ports must be omitted
      cidrIpv4: "0.0.0.0/0",
    });

    // --- ZooKeeper ingress ----------------------------------------------------
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
      // EC2 SG-rule descriptions forbid `<` and `>` (allowed set is
      // a-zA-Z0-9. _-:/()#,@[]+=&;{}!$*), so no "->" arrows here.
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
    // No rule anywhere for the ZK AdminServer (disabled via env) — port 8080
    // inside the ZK containers never listens.

    this.nifiTaskSgId = nifiSg.id;
    this.zkTaskSgId = zkSg.id;
  }
}
