import { agent, graphOf, type AgentData, type CanvasGraph } from "./canvas";

/** "Logo" (28 Oct, Masih: "we should expand the workflows; the /logo workflow"): the logo skill (p/skills/logo/SKILL.md) in one
 * agent. 29 Oct, Masih: "four agents is too extra for this, one mother and one child (the image generator which is a tool-call for
 * the model) would do the job. use sol high or med in fast mode." It draws three directions with the image tool, traces each
 * through SVG Studio, and the person picks. `worker` is its model: the ChatGPT route, whose agents have the image tool. */
// The tracer is outside this repository, so the agent's shell finds it in the environment Elpis starts with (README.md):
// SVG_STUDIO_MODULE, SVG Studio's built vectorize.js, and ELPIS_LOGO_SCRIPTS, the logo skill's scripts; the defaults are this
// workstation's layout. The renderer cannot read either, so the shell expands them.
const SVG_STUDIO = `SVG_STUDIO_MODULE="\${SVG_STUDIO_MODULE:-$HOME/Desktop/p/svg/mcp-server/dist/vectorize.js}"`;
const script = (name: string) => `"\${ELPIS_LOGO_SCRIPTS:-$HOME/Desktop/p/skills/logo/scripts}/${name}"`;
/** The skill's CLI wrapper (its steps 5–6): workflow agents start with the person's MCP servers off, so the MCP tool is not there. */
export const traceCommand = (source: string, output: string) => `${SVG_STUDIO} node ${script("trace.mjs")} ${source} ${output} 24`;
const MISSING = "If node cannot find vectorize.js or trace.mjs, stop and say SVG Studio is not set up: SVG_STUDIO_MODULE must name its built mcp-server/dist/vectorize.js and ELPIS_LOGO_SCRIPTS the logo skill's scripts folder, in the environment Elpis starts with. Draw no vector by hand.";
// 29 Oct, Masih: "What breaks it is bad image prompting." The first live run asked for abstract angular planes, a block R and a
// chain link, and got generic marks. The approved collection prompts (p/skills/logo/SKILL.md, step 1) draw one concrete subject.
const PROMPTS = ["Write each prompt as a logo designer would: one concrete, recognizable subject that carries the meaning (two offset robot heads",
  "for many agents; a crane whose wing folds around a sun for a tea house), never abstract planes, plain letters or generic geometry. Describe it",
  "part by part: pose, shapes, cutouts and where the empty space falls. Say its use and size: unmistakable at 24 px, no detail smaller than one",
  "eighth of its width, filling 85% of the square canvas. Ask for one flat ink colour (a hex code) on genuine transparency, and end with a short",
  "no-list: gradients, shading, outlines, text, badge, mockup."].join(" ");

export function logoTeam(folder: string, brand: string, worker: Partial<AgentData> = {}): CanvasGraph {
  const at = (name: string) => folder === "." ? name : `${folder}/${name}`, logo = at("logo");
  const designer = agent("Logo", [
    `Make the logo of ${brand}. First read what ${brand} is (its README or VISION.md).`,
    `Draw three distinct directions with the built-in image generation tool, one image a call, saved as ${logo}/1.png, 2.png and 3.png, with the exact prompt of each in ${logo}/prompts.md.`,
    PROMPTS,
    `Then trace each image into ${logo}/1.svg, 2.svg and 3.svg through SVG Studio's CLI wrapper (the MCP tool is off in this chat), from the project's folder, for example: ${traceCommand(`${logo}/1.png`, `${logo}/1.svg`)}`,
    MISSING,
    `Answer with the three pairs of paths, one line on each direction, and leave the choice to the person.`].join("\n"),
    { ...worker, effort: "medium", fast: true, check: false, writeScopes: [logo],
      acceptanceCriteria: [`${logo}/1.png, 2.png and 3.png are three distinct directions, each with its prompt in prompts.md`, "Each has its traced SVG beside it"] });
  return { ...graphOf("Logo", [designer], []), result: `${logo}/1.svg`, planningPattern: "logo" };
}
