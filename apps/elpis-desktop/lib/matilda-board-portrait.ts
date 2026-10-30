import type { FileId } from "@excalidraw/excalidraw/element/types";
import type { BinaryFileData } from "@excalidraw/excalidraw/types";
import { BOARD_FACE, replyPortrait } from "@/bridge/matilda-face.cjs";
import { PORTRAITS, portraitSources } from "@/lib/matilda-portraits.cjs";

type Portrait = Parameters<typeof portraitSources>[0];
export const BOARD_PORTRAIT_PREFIX = "matilda-face-";

/** Board faces are the built-in raster images that Excalidraw displays correctly in both themes. */
export function boardPortrait(choice: Portrait): BinaryFileData {
  const name = choice === "auto" ? "listening" : choice;
  const source = name === "portrait" ? BOARD_FACE : replyPortrait(`<!--matilda:${name}-->`).board;
  return { id: `${BOARD_PORTRAIT_PREFIX}${name}` as FileId, mimeType: "image/webp", dataURL: source.dataURL as BinaryFileData["dataURL"], created: 0 };
}

export function boardExpression(value: unknown): Portrait {
  return PORTRAITS.some(choice => choice.value !== "auto" && choice.value === value) ? value as Portrait : "listening";
}
