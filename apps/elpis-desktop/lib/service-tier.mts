/** The catalog calls OpenAI Fast "priority"; older engines may call it "fast". */
export const fastServiceTier = (model: { serviceTiers?: { id: string }[] } | null | undefined) =>
  model?.serviceTiers?.find(tier => tier.id === "priority" || tier.id === "fast")?.id ?? null;
