export type Role = "nifi" | "zk";
export type AzIndex = 0 | 1 | 2;
export type Ordinal = 1 | 2 | 3;

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

export const SLOTS = [
  { role: "nifi", name: "nifi-1", ordinal: 1, azIndex: 0 },
  { role: "nifi", name: "nifi-2", ordinal: 2, azIndex: 1 },
  { role: "nifi", name: "nifi-3", ordinal: 3, azIndex: 2 },
  { role: "zk", name: "zk-1", ordinal: 1, azIndex: 0 },
  { role: "zk", name: "zk-2", ordinal: 2, azIndex: 1 },
  { role: "zk", name: "zk-3", ordinal: 3, azIndex: 2 },
] as const satisfies readonly NodeSlot[];

export type Slot = (typeof SLOTS)[number];
export type SlotName = Slot["name"];
export type SlotOfRole<R extends Role> = Extract<Slot, { role: R }>;
export type NifiSlotName = SlotOfRole<"nifi">["name"];

export function slotsOfRole<R extends Role>(role: R): SlotOfRole<R>[] {
  return SLOTS.filter((s): s is SlotOfRole<R> => s.role === role);
}

export function perSlot<T>(build: (slot: Slot) => T): Record<SlotName, T> {
  const out: Partial<Record<SlotName, T>> = {};
  for (const s of SLOTS) out[s.name] = build(s);
  return out as Record<SlotName, T>;
}

export function slotVolumeTag(slot: Slot): string {
  return `${slot.name}-data`;
}

export function slotNodeRole(slot: Slot): "nifi" | "zookeeper" {
  return slot.role === "nifi" ? "nifi" : "zookeeper";
}
