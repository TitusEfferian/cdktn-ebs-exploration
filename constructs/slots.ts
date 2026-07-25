// The slot table: single source of truth for the six stateful node slots
// (3 NiFi + 3 ZooKeeper) and their AZ placement. Everything per-slot — EBS
// volume, ASG, capacity provider, Cloud Map service, ECS service, container
// env — derives from these rows, so adding/moving a node is a one-row change.
//
// `ordinal` exists so ZooKeeper's myid and NiFi's numbering never come from
// string-parsing the name (which would go `string | undefined` under
// noUncheckedIndexedAccess and break on a rename).

export type Role = "nifi" | "zk";
export type AzIndex = 0 | 1 | 2;
export type Ordinal = 1 | 2 | 3;

// Discriminated union: the name pattern is tied to the role so a row can never
// claim role "zk" with a "nifi-*" name (and vice versa).
export type NodeSlot =
  | {
      readonly role: "nifi";
      readonly name: `nifi-${"1" | "2" | "3"}`;
      readonly ordinal: Ordinal;
      readonly azIndex: AzIndex;
    }
  | {
      readonly role: "zk";
      readonly name: `zk-${"1" | "2" | "3"}`;
      readonly ordinal: Ordinal;
      readonly azIndex: AzIndex;
    };

// azIndex maps into Network's azs / privateSubnets arrays:
// 0 => ap-northeast-1a, 1 => ap-northeast-1c, 2 => ap-northeast-1d.
// `as const` keeps the 6 literal row types (and makes the tuple readonly);
// `satisfies` validates every row against NodeSlot without widening. The target
// must be `readonly NodeSlot[]` — the as-const tuple is readonly and readonly
// arrays are not assignable to mutable NodeSlot[].
export const SLOTS = [
  { role: "nifi", name: "nifi-1", ordinal: 1, azIndex: 0 },
  { role: "nifi", name: "nifi-2", ordinal: 2, azIndex: 1 },
  { role: "nifi", name: "nifi-3", ordinal: 3, azIndex: 2 },
  { role: "zk", name: "zk-1", ordinal: 1, azIndex: 0 },
  { role: "zk", name: "zk-2", ordinal: 2, azIndex: 1 },
  { role: "zk", name: "zk-3", ordinal: 3, azIndex: 2 },
] as const satisfies readonly NodeSlot[];

// Prefer these over NodeSlot downstream: they carry the 6 exact row types.
export type Slot = (typeof SLOTS)[number];
export type SlotName = Slot["name"];
export type SlotOfRole<R extends Role> = Extract<Slot, { role: R }>;

// Manual type predicate: the generic comparison defeats TS 5.5+ predicate
// auto-inference. Keep the body to exactly this discriminant equality —
// predicates are trusted, not checked.
export function slotsOfRole<R extends Role>(role: R): SlotOfRole<R>[] {
  return SLOTS.filter((s): s is SlotOfRole<R> => s.role === role);
}

// Type-safe per-slot resource accumulation: checked keys, no `| undefined` at
// lookup (unlike Map.get). Sole assertion is sound because the loop covers
// every SlotName by construction.
export function perSlot<T>(build: (slot: Slot) => T): Record<SlotName, T> {
  const out: Partial<Record<SlotName, T>> = {};
  for (const s of SLOTS) out[s.name] = build(s);
  return out as Record<SlotName, T>;
}

// The volume Name tag the boot program discovers by (globally unique across
// slots — nifi-1 and zk-1 share an AZ, so the tag value alone must
// disambiguate; the boot program refuses to guess between duplicates).
export function slotVolumeTag(slot: Slot): string {
  return `${slot.name}-data`;
}

// NODE_ROLE env value for the boot program; spelled out because it doubles as
// the host directory name under /mnt/ebs/.
export function slotNodeRole(slot: Slot): "nifi" | "zookeeper" {
  return slot.role === "nifi" ? "nifi" : "zookeeper";
}
