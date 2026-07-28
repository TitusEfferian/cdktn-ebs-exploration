import { Construct } from "constructs";
import { ServiceDiscoveryPrivateDnsNamespace } from "@cdktn/provider-aws/lib/service-discovery-private-dns-namespace";
import { ServiceDiscoveryService } from "@cdktn/provider-aws/lib/service-discovery-service";
import { perSlot, type SlotName } from "./slots";

export interface ServiceDiscoveryProps {
  readonly vpcId: string;
  // Private DNS zone name; slot FQDNs become <slot>.<namespaceName>. Frozen
  // into ZOO_SERVERS / NiFi cluster addresses (and, later, TLS cert SANs) —
  // changing it after first deploy means re-issuing certs and re-forming the
  // cluster, so treat it as immutable.
  readonly namespaceName: string;
  readonly tags: Record<string, string>;
}

// Cloud Map private DNS namespace + one A-record service per slot. ECS
// registers/deregisters each task's ENI IP automatically (serviceRegistries on
// the ECS service), giving quorum members stable names with ~10s failover.
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
          // MULTIVALUE + TTL 10: single-task services resolve to the one task
          // IP; low TTL bounds client staleness after a task replacement.
          routingPolicy: "MULTIVALUE",
          dnsRecords: [{ type: "A", ttl: 10 }],
        },
        // NO health_check_custom_config block — deliberately. The provider
        // never persists an empty block to state (state shows []), so a
        // present-but-empty block diffs on EVERY plan, and the block is
        // ForceNew: each apply then REPLACES all six discovery services,
        // silently deregistering every record that live tasks had registered.
        // Observed 2026-07-28: a taskdef-only apply wiped the zk-* A records
        // and crash-looped the whole NiFi cluster (ECS re-registers a task
        // only at task start, so stable long-running tasks never come back).
        // Omission changes nothing functionally for 1-task services: ECS still
        // registers/deregisters the task IP on start/stop, and with no health
        // config the record always resolves.
        // Demo teardown: deregister any lingering instances on destroy.
        forceDestroy: true,
        tags: props.tags,
      });
    });

    this.namespaceName = props.namespaceName;
    this.namespaceId = namespace.id;
    this.serviceArns = perSlot((slot) => services[slot.name].arn);
  }
}
