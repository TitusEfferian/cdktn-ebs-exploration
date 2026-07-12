// Container definitions for the busybox demo task, built as a typed factory so
// AppService stays declarative. Keys are ECS camelCase (the module JSON-encodes
// them into the task definition), unlike Terraform snake_case block arguments.

export interface ContainerMountPoint {
  readonly sourceVolume: string;
  readonly containerPath: string;
  readonly readOnly: boolean;
}

export interface ContainerDefinition {
  readonly image: string;
  readonly essential: boolean;
  readonly cpu: number;
  readonly memory: number;
  readonly command: string[];
  readonly mountPoints: ContainerMountPoint[];
  readonly linuxParameters: { readonly initProcessEnabled: boolean };
  readonly readonlyRootFilesystem: boolean;
}

// Build the busybox container definitions. `sourceVolume` must equal the ECS
// service volume key so the mount resolves.
export function containerDefinitions(
  sourceVolume: string,
): Record<string, ContainerDefinition> {
  return {
    app: {
      image: "busybox:latest",
      essential: true,
      cpu: 256,
      memory: 512,
      // busybox has no bash and no `sleep infinity`; keep it alive with a loop
      command: ["sh", "-c", "while true; do sleep 3600; done"],
      mountPoints: [
        {
          sourceVolume, // must equal the volume key in the service
          containerPath: "/data",
          readOnly: false,
        },
      ],
      linuxParameters: {
        initProcessEnabled: true, // required for ECS Exec
      },
      readonlyRootFilesystem: false, // Exec injects the SSM agent into the FS
    },
  };
}
