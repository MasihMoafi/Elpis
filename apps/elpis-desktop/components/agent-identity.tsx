import { providerLabel, subscriptionOf } from "@/lib/api";

const palette = [
  { name: "gold", background: "#f2c14e", foreground: "#18130b" },
  { name: "purple", background: "#7544a9", foreground: "#ffffff" },
  { name: "black", background: "#16191c", foreground: "#ffffff" },
  { name: "red", background: "#b82f3c", foreground: "#ffffff" },
  { name: "teal", background: "#087569", foreground: "#ffffff" },
  { name: "blue", background: "#2959ae", foreground: "#ffffff" },
  { name: "green", background: "#26713e", foreground: "#ffffff" },
  { name: "pink", background: "#a83270", foreground: "#ffffff" },
  { name: "orange", background: "#a94f1a", foreground: "#ffffff" },
  { name: "indigo", background: "#4e48a7", foreground: "#ffffff" },
  { name: "brown", background: "#85512a", foreground: "#ffffff" },
  { name: "rose", background: "#962f50", foreground: "#ffffff" },
  { name: "citron", background: "#626c0f", foreground: "#ffffff" },
  { name: "navy", background: "#233e75", foreground: "#ffffff" },
  { name: "magenta", background: "#962c91", foreground: "#ffffff" },
  { name: "slate", background: "#445b61", foreground: "#ffffff" },
] as const;

/** Derive team slots from existing ancestry and creation order; status/filter changes do not affect them. */
export function agentColourSlots(threads: readonly { id: string; parentThreadId?: string | null; createdAt?: number }[]) {
  const byId = new Map(threads.map(thread => [thread.id, thread]));
  const groups = new Map<string, typeof threads[number][]>();
  for (const thread of byId.values()) {
    if (!thread.parentThreadId) continue;
    let root = thread.parentThreadId;
    const seen = new Set([thread.id]);
    while (!seen.has(root)) {
      seen.add(root);
      const next = byId.get(root)?.parentThreadId;
      if (!next) break;
      root = next;
    }
    const group = groups.get(root) ?? [];
    group.push(thread); groups.set(root, group);
  }
  const slots = new Map<string, number>();
  for (const [root, group] of groups) {
    group.sort((a, b) => (a.createdAt ?? Number.MAX_SAFE_INTEGER) - (b.createdAt ?? Number.MAX_SAFE_INTEGER) || a.id.localeCompare(b.id));
    group.forEach((thread, index) => slots.set(thread.id, index));
    slots.set(root, group.length);
  }
  return slots;
}

/** One stable mark per agent; callers supply only observed runtime model/provider values. */
export function AgentIdentity({ id, name, model, provider, role, compact = false, nameClassName, colourSlot }: {
  id: string; name: string; model?: string | null; provider?: string | null; role?: string; compact?: boolean; nameClassName?: string; colourSlot?: number;
}) {
  let hash = 2166136261;
  for (const character of id) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  const mark = (hash >>> 0).toString(36).padStart(3, "0").slice(-3).toUpperCase();
  let colour = hash;
  colour ^= colour >>> 16; colour = Math.imul(colour, 0x7feb352d);
  colour ^= colour >>> 15; colour = Math.imul(colour, 0x846ca68b); colour ^= colour >>> 16;
  const paint = palette[(colourSlot ?? (colour >>> 0)) % palette.length];
  // A subscription's model names its route (agy/, claude/), and the engine reports its own provider for it: the model
  // decides (28 Oct: rows said "openai · agy/gemini-3.8-flash-high").
  const subscription = subscriptionOf(model);
  const runtime = [role, providerLabel(model, provider?.trim()), subscription ? model!.slice(subscription.prefix.length) : model?.trim()].filter(Boolean).join(" · ");
  return <span className="agent-identity inline-flex min-w-0 max-w-full items-center gap-2" data-compact={compact || undefined}>
    <span className={`agent-mark inline-flex shrink-0 items-center justify-center rounded border border-border bg-muted font-mono text-xs leading-none ${compact ? "size-7" : "size-8"}`} data-agent-colour={paint.name} style={{ color: paint.foreground, backgroundColor: paint.background, borderColor: `light-dark(color-mix(in srgb, ${paint.background}, black 35%), color-mix(in srgb, ${paint.background}, white 40%))` }} role="img" aria-label={`Agent mark ${mark}`}><svg aria-hidden="true" viewBox="0 0 9 9" className="size-5" fill="currentColor">{Array.from({ length: 28 }, (_, bit) => {
      if (!((hash >>> bit) & 1)) return null;
      const x = bit % 4, y = Math.floor(bit / 4);
      return <g key={bit}><rect x={x + 1} y={y + 1} width="0.8" height="0.8" />{x !== 3 && <rect x={7 - x} y={y + 1} width="0.8" height="0.8" />}</g>;
    })}</svg></span>
    <span className="agent-identity-text flex min-w-0 flex-col">
      <span className={`agent-name block truncate font-medium ${nameClassName || ""}`}>{name}</span>
      {runtime && <span className="agent-model block truncate text-xs text-muted-foreground" title={runtime}>{runtime}</span>}
    </span>
  </span>;
}
