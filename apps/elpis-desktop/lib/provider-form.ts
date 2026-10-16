export type ProviderType = "openrouter" | "local" | "custom";
type ProviderIdentity = { type: ProviderType; name: string; existingId?: string };

export function providerFormId({ type, name, existingId }: ProviderIdentity, existingIds: readonly string[]): string {
  if (existingId !== undefined) return existingId;
  // Type prefixes keep new connections separate from reserved sign-in routes.
  const prefix = type === "custom" ? "api" : type;
  const slug = name.normalize("NFKD").toLowerCase().replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const base = (slug && slug !== prefix ? `${prefix}-${slug}` : prefix).slice(0, 64);
  const occupied = new Set(existingIds.map(id => id.toLowerCase()));
  let id = base, suffix = 2;
  while (occupied.has(id)) {
    const ending = `-${suffix++}`;
    id = `${base.slice(0, 64 - ending.length)}${ending}`;
  }
  return id;
}
