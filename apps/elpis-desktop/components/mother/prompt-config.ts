// Adapted from DeepSeek dsh-superagent-prototype (MIT), src/client/prompt-config.ts.
/** Pure helpers for editing prompt sections/skills and computing folded line diffs. */
import type { PromptConfig, PromptsView } from "./api.ts";
import { valueLabel, type T } from "./text.ts";

type TeamSection = PromptsView["sections"][number];
export type BuiltInPart = PromptsView["parts"][number];
export const isSkill = (name: string): name is `skill/${string}` => name.startsWith("skill/");
/** A built-in part, which the editor names `part/<key>`, apart from the team skills (`skill/<name>`). */
export const isPart = (name: string): name is `part/${string}` => name.startsWith("part/");
export const partKey = (name: `part/${string}`): string => name.slice(5);
export const sections = (config: PromptConfig): string[] => [
  ...Object.keys(config).filter(name => name !== "skills" && name !== "overrides"),
  ...Object.keys(config.skills).map(name => `skill/${name}`),
  ...Object.keys(config.overrides ?? {}).map(key => `part/${key}`),
];
/** Returns a team section or team skill's text, a built-in part's override, or `undefined` for one the team did not write. */
export const sectionText = (config: PromptConfig, name: string): string | undefined =>
  isPart(name)
    ? config.overrides?.[partKey(name)]?.text
    : isSkill(name)
      ? config.skills[name.slice(6)]
      : name !== "skills" && name !== "overrides" && Object.hasOwn(config, name)
        ? config[name as TeamSection]
        : undefined;
/**
 * A configuration with its overrides, none as an empty map, as the editor keeps it: a draft and the version it moves onto then
 * merge override by override, as a host stores no overrides as none. With `parts`, only the overrides of those parts stay, as
 * a version loaded from the history may override a part this version no longer has.
 */
export const withOverrides = (config: PromptConfig, parts?: readonly { key: string }[]): PromptConfig => ({
  ...config,
  overrides: Object.fromEntries(
    Object.entries(config.overrides ?? {}).filter(([key]) => !parts || parts.some(part => part.key === key)),
  ),
});
/** The text a built-in part reads with: the team's override, else its built-in text. */
export const partText = (config: PromptConfig, part: BuiltInPart): string =>
  config.overrides?.[part.key]?.text ?? part.text;
/**
 * Override a built-in part with `text`: an override keeps the built-in text it was edited from, the current one when new or
 * when `rebase`, and goes when its text is the built-in text again.
 */
export function withOverride(
  config: PromptConfig,
  part: BuiltInPart,
  text: string | undefined,
  rebase = false,
): PromptConfig {
  const { [part.key]: previous, ...others } = config.overrides ?? {};
  const base = rebase ? part.base : (previous?.base ?? part.base);
  return {
    ...config,
    overrides: text === undefined || text === part.text ? others : { ...others, [part.key]: { text, base } },
  };
}
export function withSection(config: PromptConfig, name: string, text: string): PromptConfig {
  return isSkill(name)
    ? { ...config, skills: { ...config.skills, [name.slice(6)]: text } }
    : { ...config, [name]: text };
}
export function withoutSkill(config: PromptConfig, name: string): PromptConfig {
  const { [name.slice(6)]: _removed, ...skills } = config.skills;
  return { ...config, skills };
}
/** The sections, skills and overrides of a draft that differ from the saved version; an override re-based counts too. */
export const changedSections = (config: PromptConfig, saved: PromptConfig): string[] =>
  [...new Set([...sections(config), ...sections(saved)])].filter(name =>
    isPart(name)
      ? JSON.stringify(config.overrides?.[partKey(name)]) !== JSON.stringify(saved.overrides?.[partKey(name)])
      : sectionText(config, name) !== sectionText(saved, name),
  );
export const sectionLabel = (t: T, view: Pick<PromptsView, "skillPrefix">, name: string): string =>
  isPart(name)
    ? valueLabel(t, "promptPart", partKey(name))
    : isSkill(name)
      ? `${view.skillPrefix}${name.slice(6)}`
      : valueLabel(t, "promptPart", name);
export const skillNameFree = (
  name: string,
  config: PromptConfig,
  view: Pick<PromptsView, "skillName" | "builtin">,
): boolean =>
  new RegExp(view.skillName).test(name) && !Object.hasOwn(config.skills, name) && !view.builtin.includes(name);
/** Formats a team prompt part with its heading (omitted for skills, which have no heading). */
export const partWith = (part: { name: string; heading?: string | undefined }, base: string): string =>
  part.heading === undefined ? base : `${part.heading}\n${base}`;

export type DiffLine = { kind: "same" | "del" | "ins"; text: string } | { kind: "fold"; count: number };
/** Compute a line diff, folding runs of more than four unchanged lines to their boundary lines and a count. */
export function lineDiff(before: string, after: string): DiffLine[] {
  const a = before.split("\n"),
    b = after.split("\n");
  // Fill LCS table from the end so the forward pass below reconstructs the diff in order.
  const lcs = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
  const lines: { kind: "same" | "del" | "ins"; text: string }[] = [];
  for (let i = 0, j = 0; i < a.length || j < b.length;) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      lines.push({ kind: "same", text: a[i]! });
      i++;
      j++;
    } else if (j < b.length && (i === a.length || lcs[i]![j + 1]! >= lcs[i + 1]![j]!))
      lines.push({ kind: "ins", text: b[j++]! });
    else lines.push({ kind: "del", text: a[i++]! });
  }
  const folded: DiffLine[] = [];
  for (let k = 0; k < lines.length;) {
    let end = k;
    while (end < lines.length && lines[end]!.kind === "same") end++;
    if (end - k > 4) folded.push(lines[k]!, { kind: "fold", count: end - k - 2 }, lines[end - 1]!);
    else folded.push(...lines.slice(k, Math.max(end, k + 1)));
    k = Math.max(end, k + 1);
  }
  return folded;
}
