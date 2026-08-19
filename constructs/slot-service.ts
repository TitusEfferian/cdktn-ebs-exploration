import { Construct } from "constructs";
import { ITerraformDependable } from "cdktn";
import { EcsService } from "../.gen/modules/ecs_service";
import { nifiContainerDefinitions, zookeeperContainerDefinitions } from "./container-definitions";
import { slotsOfRole, type NifiSlotName, type Slot } from "./slots";

export interface SlotServiceProps {
  readonly slot: Slot;
  readonly clusterArn: string;
  readonly subnetId: string;
  readonly securityGroupId: string;
  readonly registryArn: string;
  readonly namespaceName: string;
  readonly sensitiveKeySecretArn: string;
  readonly tlsKeystorePasswordArn: string;
  readonly tlsTruststorePasswordArn: string;
  readonly tlsKeystoreB64Arns: Record<NifiSlotName, string>;
  readonly tlsTruststoreB64Arn: string;
  readonly tags: Record<string, string>;
  readonly dependsOn: ITerraformDependable[];
}

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
      runtimePlatform: {
        cpu_architecture: "ARM64",
        operating_system_family: "LINUX",
      },
      cpu: isNifi ? 1024 : 256,
      memory: isNifi ? 3072 : 1024,
      desiredCount: 1,
      enableAutoscaling: false,
      enableExecuteCommand: true,
      capacityProviderStrategy: {
        [slot.name]: { capacity_provider: slot.name, weight: 1, base: 1 },
      },
      deploymentMinimumHealthyPercent: 0,
      deploymentMaximumPercent: 100,
      availabilityZoneRebalancing: "DISABLED",
      networkMode: "awsvpc",
      subnetIds: [props.subnetId],
      createSecurityGroup: false,
      securityGroupIds: [props.securityGroupId],
      serviceRegistries: { registry_arn: props.registryArn },
      volume: isNifi
        ? {
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
      ...(isNifi
        ? {
            taskExecSecretArns: [
              props.sensitiveKeySecretArn,
              props.tlsKeystorePasswordArn,
              props.tlsTruststorePasswordArn,
              props.tlsKeystoreB64Arns[slot.name],
              props.tlsTruststoreB64Arn,
            ],
          }
        : {}),
      containerDefinitions: isNifi
        ? nifiContainerDefinitions({
            slotName: slot.name,
            namespaceName: props.namespaceName,
            zkConnectString,
            sensitiveKeySecretArn: props.sensitiveKeySecretArn,
            tlsKeystorePasswordArn: props.tlsKeystorePasswordArn,
            tlsTruststorePasswordArn: props.tlsTruststorePasswordArn,
            tlsKeystoreB64SecretArn: props.tlsKeystoreB64Arns[slot.name],
            tlsTruststoreB64SecretArn: props.tlsTruststoreB64Arn,
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
