/** The catalog calls OpenAI Fast "priority"; older engines may call it "fast". */
export const fastServiceTier = model => model?.serviceTiers?.find(tier => tier.id === 'priority' || tier.id === 'fast')?.id ?? null;
