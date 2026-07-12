import { Construct } from "constructs";
import { ITerraformDependable } from "cdktn";
import { EcsService } from "../.gen/modules/ecs_service";
import { containerDefinitions } from "./container-definitions";

export interface AppServiceProps {
  readonly serviceName: string;
  readonly clusterArn: string;
  readonly capacityProviderName: string;
  readonly tags: Record<string, string>;
  // Cluster + ASG that must exist before the service (matches the original depends_on).
  readonly dependsOn: ITerraformDependable[];
}

// The ECS service running the busybox demo task on the EC2 capacity provider.
export class AppService extends Construct {
  public readonly serviceName: string;

  constructor(scope: Construct, id: string, props: AppServiceProps) {
    super(scope, id);

    const service = new EcsService(this, "service", {
      dependsOn: props.dependsOn,
      name: props.serviceName,
      clusterArn: props.clusterArn,
      requiresCompatibilities: ["EC2"],
      capacityProviderStrategy: {
        [props.capacityProviderName]: {
          capacity_provider: props.capacityProviderName,
          weight: 1,
          base: 1,
        },
      },
      networkMode: "bridge",
      createSecurityGroup: false, // bridge mode => no task ENI/SG
      cpu: 256,
      memory: 512,
      // Match the arm64 (Graviton t4g.small) instance. The module defaults
      // runtime_platform to X86_64, which makes the task unplaceable on an arm64
      // host — it sits in PROVISIONING forever. `any`-typed input => nested keys
      // are emitted verbatim in Terraform snake_case.
      runtimePlatform: {
        cpu_architecture: "ARM64",
        operating_system_family: "LINUX",
      },
      enableExecuteCommand: true,
      deploymentMinimumHealthyPercent: 0,
      deploymentMaximumPercent: 100,
      deploymentCircuitBreaker: { enable: true, rollback: true },
      volume: {
        data: {
          host_path: "/mnt/ebs",
        },
      },
      containerDefinitions: containerDefinitions("data"),
      tags: props.tags,
    });

    this.serviceName = service.nameOutput;
  }
}
