import type { CatalogModel, Command } from './canvas-types.ts';
export const EFFORTS = ["minimal", "low", "medium", "high", "xhigh"];
/** A command's first part (count, model, thinking) and the rest, which starts at the first colon or new line. */
export function commandParts(text: string) {
    const cut = text.search(/[:\n]/);
    return cut < 0 ? { head: text, rest: "" } : { head: text.slice(0, cut), rest: text.slice(cut) };
}
export const prompts = (text: string) => text.split(/[;\n]/).map(task => task.trim()).filter(Boolean);
export function parseCommand(text: string, catalog: CatalogModel[]): Command {
    const { head, rest } = commandParts(text);
    const command: Command = { count: null, note: false, model: null, effort: null, tasks: prompts(rest.slice(1)), unknown: [], prompted: false };
    const words: string[] = [];
    let provider: string | null = null;
    for (const raw of head.toLowerCase().split(/\s+/).filter(Boolean))
        for (const word of raw.match(/^(\d+)([a-z].*)$/)?.slice(1) ?? [raw]) {
            const effort = word.length >= 3 ? EFFORTS.find(item => item.startsWith(word)) : undefined;
            if (/^\d+$/.test(word) && command.count === null)
                command.count = Number(word);
            else if (word.startsWith("@") && word.length > 1)
                provider = word.slice(1);
            else if (word === "note" && !command.note)
                command.note = true;
            else if (effort && !command.effort)
                command.effort = effort;
            else
                words.push(word);
        }
    if (words.length || provider) {
        const pool = catalog.filter(item => !provider || (item.provider ?? "").toLowerCase().startsWith(provider) || item.providerLabel.toLowerCase().startsWith(provider));
        const named = (item: CatalogModel) => `${item.label} ${item.model} ${item.providerLabel}`.toLowerCase();
        // Each word narrows the models; a word that would leave none is not part of the name.
        let matches = pool, named_ = false;
        for (const word of words) {
            const narrower = matches.filter(item => named(item).includes(word));
            if (narrower.length) {
                matches = narrower;
                named_ = true;
            }
            else
                command.unknown.push(word);
        }
        command.model = named_ ? matches[0] ?? null : null;
        if (provider && !pool.length)
            command.unknown.push(`@${provider}`);
    }
    // Without a colon, a first line that isn't all command words is a prompt: the whole text is prompts.
    if (!rest.startsWith(":") && command.unknown.length)
        return { count: null, note: false, model: null, effort: null, tasks: prompts(text), unknown: [], prompted: true };
    return command;
}
