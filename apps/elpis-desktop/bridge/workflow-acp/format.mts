
/** Inline and spill (1 Nov): a later agent and the Mother get a child's summary and the file with its whole answer. */
export const SUMMARY = 1500;

export const summarize = (answer: unknown) => String((answer ?? '') as string).length <= SUMMARY ? String((answer ?? '') as string) : `${String(answer).slice(0, SUMMARY).replace(/\s+\S*$/, '')} … (the whole answer is in the file)`;

export const slug = (text: unknown) => String(text).normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/, '');
