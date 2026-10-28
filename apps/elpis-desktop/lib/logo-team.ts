import { agent, chain, graphOf, ownFolders, type AgentData, type CanvasGraph } from "./canvas";

/** "Logo" (28 Oct, Masih: "we should expand the workflows; the /logo workflow"): the logo skill (p/skills/logo/SKILL.md) as a team,
 * on the private artwork workflow (vector-collection/private/ARTWORK-WORKFLOW.md, steps 1–8). A Designer writes one brief and
 * draws three numbered directions with the image generation tool, a Curator rejects and selects with reasons, a Tracer converts the
 * chosen original through SVG Studio and frames it, and a Critic judges the source/vector pair and the sheet. One after the other,
 * all in logo/ inside the project. `worker` is the model of the four: the ChatGPT route, whose agents have the image tool. */
const SVG_STUDIO = "/home/masih/Desktop/p/svg/mcp-server/dist/vectorize.js";
const SCRIPTS = "/home/masih/Desktop/p/skills/logo/scripts";
/** The skill's CLI wrapper (its steps 5–6): workflow agents start with the person's MCP servers off, so the MCP tool is not there. */
export const traceCommand = (source: string, output: string) => `SVG_STUDIO_MODULE=${SVG_STUDIO} node ${SCRIPTS}/trace.mjs ${source} ${output} 24`;
const proofCommand = (sheet: string, source: string, vector: string) => `SVG_STUDIO_MODULE=${SVG_STUDIO} node ${SCRIPTS}/proof.mjs ${sheet} ${source} ${vector}`;
// 28 Oct, the first live run: a check that may prove things any way it likes read the engine's session logs for seven
// minutes. A check judges the named files by sight and opens nothing else.
const VISION = "by your own vision. Run no scripts, and open only the files named here: no logs, chat records or tool output.";

export function logoTeam(folder: string, brand: string, worker: Partial<AgentData> = {}): CanvasGraph {
  const at = (name: string) => folder === "." ? name : `${folder}/${name}`, output = at("logo/logo.svg");
  const candidates = at("logo/candidates"), choice = at("logo/choice.md"), proof = at("logo/proof.png"), sheet = at("logo/sheet.html");
  const chosen = `${candidates}/N.png`;
  const designer = agent("Designer", [
    `Design the logo of ${brand}. First write one brief in your own folder as brief.md: what the mark must say, flat fills, clean contours, large negative space, and that it must read at 24 px on light and on dark.`,
    `Then draw three distinct directions from that brief with the built-in image generation tool, one image a call, and save them as ${candidates}/1.png, 2.png and 3.png, with the exact prompt of each in ${candidates}/prompts.md.`,
    `Draw each direction once; redraw one at most once, only if it plainly fails the brief. No hand-coded SVG, no other image service: if the tool is missing, say so and stop. Answer with the paths.`].join("\n"),
    { ...worker, writeScopes: [candidates], acceptanceCriteria: [`${candidates}/1.png, 2.png and 3.png are three distinct directions from one brief`, "prompts.md holds the prompt each was drawn from"],
      check: `Open the three candidates beside prompts.md and brief.md, ${VISION} Say whether they are three distinct directions of the brief, or which repeat each other or stray from it.` });
  const curator = agent("Curator", [
    `Open ${candidates}/1.png, 2.png and 3.png beside ${candidates}/prompts.md, with your own vision. Reject generic silhouettes, clutter, needless satellites, repeated meanings and weak negative space.`,
    `Select one and write ${choice}: its number on the first line as "Choice: N", then why it, and what each other one failed on. A rejected design never returns. Answer with the path of choice.md.`].join("\n"),
    { ...worker, writeScopes: [at("logo")], acceptanceCriteria: ["choice.md names one candidate, with reasons for it and against the others"],
      check: `Open the three candidates beside choice.md, ${VISION} Say whether the chosen one is the cleanest mark with the clearest negative space, or which is.` });
  const tracer = agent("Tracer", [
    `Read ${choice}: its first line names the chosen candidate, N. Trace that original with SVG Studio's tracer through its CLI wrapper (the MCP tool is off in this chat), from the project's folder:`,
    traceCommand(chosen, output),
    `Then frame the viewBox optically: the ink's bounds plus an even margin, the paths unchanged. Keep every hole (compound paths with their inner contours) and every explicit fill; redraw nothing.`,
    `Write ${sheet}: logo.svg inline at 24, 32 and 64 px, once on white and once on #10151d. Then make the proof sheet of the pair: ${proofCommand(proof, chosen, output)}`,
    `Answer with the paths of logo.svg, sheet.html and proof.png.`].join("\n"),
    { ...worker, writeScopes: [at("logo")], acceptanceCriteria: ["logo.svg is real vector paths with explicit fills, a viewBox framed to the mark, and its holes kept", "sheet.html shows it at 24, 32 and 64 px on light and on dark"],
      check: `Open ${proof} beside the candidate ${choice} names and the text of ${output}, ${VISION} Paths and fills only: no image, script, foreignObject or font. Say whether the vector keeps the source's silhouette, holes and negative space at every size, or where it loses them.` });
  const critic = agent("Critic", [
    `Judge the logo of ${brand} as a reviewer who may fail it. Open the candidate ${choice} names beside ${output}, ${proof} and the markup of ${sheet}, with your own vision.`,
    `Check, as step 7 of the artwork workflow asks: the source/vector pair matches; negative spaces and holes survive; contours are crisp; contrast and margins hold on light and on dark; the 24 px mark still reads.`,
    `Write verdict.md in your own folder: pass or fail, and each failing point with its reason and the size and background where it shows. A visibly damaged result fails even when a numeric average is high.`].join("\n"),
    { ...worker, acceptanceCriteria: ["verdict.md passes or fails the pair and the sheet, each failure with its reason"],
      check: `Read verdict.md beside ${proof}, ${VISION} Say whether each verdict matches what the proof shows.` });
  const team = graphOf("Logo", [designer, curator, tracer, critic], chain(designer, curator, tracer, critic)), own = ownFolders(team);
  return { ...team, result: output, planningPattern: "logo",
    nodes: team.nodes.map(node => node.type === "agent" && node.id === critic.id ? { ...node, data: { ...node.data, writeScopes: [own.get(node.id)!] } } : node) };
}
