import { common, createLowlight } from "lowlight";
import type { ElementContent } from "hast";

const lowlight = createLowlight(common);
export type ColourRange = { from: number; to: number; className: string };
export type HighlightRequest = { id: number; language: string; text: string };
export type HighlightReply = { id: number; ranges: ColourRange[] };

// Only a viewport-sized string crosses this boundary. Neither the full document nor
// the syntax tree is retained when a reply has been posted.
onmessage = ({ data }: MessageEvent<HighlightRequest>) => {
  const ranges: ColourRange[] = [];
  let offset = 0;
  const walk = (nodes: ElementContent[], classes = "") => {
    for (const node of nodes) {
      if (node.type === "text") {
        if (classes && node.value.length) ranges.push({ from: offset, to: offset + node.value.length, className: classes });
        offset += node.value.length;
      } else if (node.type === "element") {
        const names = node.properties.className;
        walk(node.children, [classes, ...(Array.isArray(names) ? names.map(String) : [])].filter(Boolean).join(" "));
      }
    }
  };
  try { walk(lowlight.highlight(data.language, data.text.slice(0, 16_384)).children as ElementContent[]); } catch { /* Unknown languages stay plain. */ }
  postMessage({ id: data.id, ranges } satisfies HighlightReply);
};
