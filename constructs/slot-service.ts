import { Construct } from "constructs";
import { ITerraformDependable } from "cdktn";
import { EcsService } from "../.gen/modules/ecs_service";
import { nifiContainerDefinitions, zookeeperContainerDefinitions } from "./container-definitions";
import { slotsOfRole, type Slot } from "./slots";

export interface SlotServiceProps {
  readonly slot: Slot;
  readonly clusterArn: string;
  // The slot's private subnet — MUST be the same AZ as the slot ASG/volume.
  // awsvpc placement filters on the subnet's AZ; a mismatch never mis-places,
  // it just stalls in PROVISIONING (loud failure).
  readonly subnetId: string;
  // Role task SG (nifi vs zk port matrix).
  readonly securityGroupId: string;
  // Cloud Map service for this slot (A record; ECS registers the task ENI IP).
  readonly registryArn: string;
  // Private DNS suffix, e.g. "nifi.internal" — slot FQDN = <slot>.<suffix>.
  readonly namespaceName: string;
  // SecureString parameter holding nifi.sensitive.props.key (NiFi slots only).
  readonly sensitiveKeyParameterArn: string;
  readonly tags: Record<string, string>;
  // Cluster (capacity-provider association) + this slot's ASG.
  readonly dependsOn: ITerraformDependable[];
}

// One ECS service per slot, pinned to the slot's capacity provider (= its
// single-instance ASG). desired=1 with min 0% / max 100% forces stop-then-start
// replacement — two tasks of one slot must never coexist (they would collide on
// the same /mnt/ebs bind mounts, and ZK's myid).
export class SlotService extends Construct {
  public readonly serviceName: string;

  constructor(scope: Construct, id: string, props: SlotServiceProps) {
    super(scope, id);

    const { slot } = props;
    const isNifi = slot.role === "nifi";
    const zkConnectString = slotsOfRole("zk")
      .map((z) => `${z.name}.${props.namespaceName}:2181`)
      .join(",");

    const service = new EcsService(this, "service", {
      dependsOn: props.dependsOn,
      name: slot.name,
      clusterArn: props.clusterArn,
      requiresCompatibilities: ["EC2"],
      // Match the arm64 (Graviton t4g) instances. The module defaults
      // runtime_platform to X86_64, which makes the task unplaceable on an arm64
      // host — it sits in PROVISIONING forever. `any`-typed input => nested keys
      // are emitted verbatim in Terraform snake_case.
      runtimePlatform: {
        cpu_architecture: "ARM64",
        operating_system_family: "LINUX",
      },
      // Task-level sizing (module forces values; the defaults are Fargate-shaped
      // and 2048 MiB would never place on a t4g.small). Leaves OS+agent headroom:
      // t4g.medium registers ~3.8 GiB, t4g.small ~1.8 GiB.
      cpu: isNifi ? 1024 : 256,
      memory: isNifi ? 3072 : 1024,
      desiredCount: 1,
      // Module default is enable_autoscaling=true with cpu+memory target
      // tracking (1..10 tasks) — a silent foot-gun for pinned quorum slots.
      enableAutoscaling: false,
      enableExecuteCommand: true,
      // The capacity provider is the placement fence: tasks under this strategy
      // only ever run on the slot ASG's instance; when it is being replaced the
      // task waits in PROVISIONING and starts on the fresh instance.
      capacityProviderStrategy: {
        [slot.name]: { capacity_provider: slot.name, weight: 1, base: 1 },
      },
      deploymentMinimumHealthyPercent: 0,
      deploymentMaximumPercent: 100,
      // No deployment circuit breaker here (unlike the busybox demo service): on
      // a FIRST deployment there is no COMPLETED state to roll back to and a
      // tripped breaker stalls the deploy. Omitted block = disabled.
      // AZ rebalancing is meaningless for an AZ-pinned desired=1 service; set
      // explicitly (the attribute is Optional+Computed and AWS may default new
      // services to ENABLED, which would show as perpetual plan drift).
      availabilityZoneRebalancing: "DISABLED",
      networkMode: "awsvpc",
      subnetIds: [props.subnetId],
      createSecurityGroup: false, // module-created SG ships with ZERO rules
      securityGroupIds: [props.securityGroupId],
      // A record + awsvpc: registry_arn ONLY (container_name/port are for SRV).
      serviceRegistries: { registry_arn: props.registryArn },
      volume: isNifi
        ? {
            // One host dir per NiFi repository; sourceVolume keys must match
            // the container mountPoints in container-definitions.ts.
            flowfile: { host_path: "/mnt/ebs/nifi/flowfile" },
            content: { host_path: "/mnt/ebs/nifi/content" },
            provenance: { host_path: "/mnt/ebs/nifi/provenance" },
            database: { host_path: "/mnt/ebs/nifi/database" },
            state: { host_path: "/mnt/ebs/nifi/state" },
            flow: { host_path: "/mnt/ebs/nifi/flow" },
          }
        : {
            data: { host_path: "/mnt/ebs/zookeeper/data" },
            datalog: { host_path: "/mnt/ebs/zookeeper/datalog" },
          },
      // Execution-role read on the SecureString (module wires ssm:GetParameters).
      ...(isNifi ? { taskExecSsmParamArns: [props.sensitiveKeyParameterArn] } : {}),
      containerDefinitions: isNifi
        ? nifiContainerDefinitions({
            slotName: slot.name,
            namespaceName: props.namespaceName,
            zkConnectString,
            sensitiveKeyParameterArn: props.sensitiveKeyParameterArn,
          })
        : zookeeperContainerDefinitions({
            ordinal: slot.ordinal,
            namespaceName: props.namespaceName,
          }),
      tags: props.tags,
    });

    this.serviceName = service.nameOutput;
  }
}
