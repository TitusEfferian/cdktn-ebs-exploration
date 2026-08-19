import { Construct } from "constructs";
import { ServiceDiscoveryPrivateDnsNamespace } from "@cdktn/provider-aws/lib/service-discovery-private-dns-namespace";
import { ServiceDiscoveryService } from "@cdktn/provider-aws/lib/service-discovery-service";
import { perSlot, type SlotName } from "./slots";

export interface ServiceDiscoveryProps {
  readonly vpcId: string;
  readonly namespaceName: string;
  readonly tags: Record<string, string>;
}

export class ServiceDiscovery extends Construct {
  public readonly namespaceName: string;
  public readonly namespaceId: string;
  public readonly serviceArns: Record<SlotName, string>;

  constructor(scope: Construct, id: string, props: ServiceDiscoveryProps) {
    super(scope, id);

    const namespace = new ServiceDiscoveryPrivateDnsNamespace(this, "namespace", {
      name: props.namespaceName,
      vpc: props.vpcId,
      description: "NiFi/ZooKeeper slot discovery (A records, ECS-managed)",
      tags: props.tags,
    });

    const services = perSlot((slot) => {
      return new ServiceDiscoveryService(this, `sd_${slot.name.replace(/-/g, "_")}`, {
        name: slot.name,
        dnsConfig: {
          namespaceId: namespace.id,
          routingPolicy: "MULTIVALUE",
          dnsRecords: [{ type: "A", ttl: 10 }],
        },
        forceDestroy: true,
        tags: props.tags,
      });
    });

    this.namespaceName = props.namespaceName;
    this.namespaceId = namespace.id;
    this.serviceArns = perSlot((slot) => services[slot.name].arn);
  }
}
