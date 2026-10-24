/** Legacy blue notes and stable reply IDs identify Matilda; black user ink stays user-owned. */
export const MASIH_PEN = "#2f9e44";
export const agentColor = (color: string, id?: string) => id?.startsWith("love-reply-") || ["#1971c2", "#1c7ed6", "#228be6", "#1864ab", "#4dabf7", "blue", "#0000ff"].includes(color.toLowerCase());

type ImageFile = { dataURL: string; mimeType: string };
const lightImages = new WeakMap<ImageFile, Promise<ImageFile>>();
/** Keep original editor files for undo; only the saved copy needs smaller pixels. */
export async function lightImage<T extends ImageFile>(file: T): Promise<T> {
  let result = lightImages.get(file);
  if (!result) {
    result = (async () => {
      const image = new Image(); image.src = file.dataURL; await image.decode();
      const scale = Math.min(1, 1600 / Math.max(image.naturalWidth, image.naturalHeight));
      if (scale === 1) return file;
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
      const context = canvas.getContext("2d");
      if (!context) throw new Error("The drawing image could not be resized.");
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      return { ...file, dataURL: canvas.toDataURL("image/png"), mimeType: "image/png", loveSpotResized: true };
    })();
    lightImages.set(file, result);
    result.catch(() => lightImages.delete(file));
  }
  return await result as T;
}

export async function lightFiles<T extends ImageFile>(elements: readonly { isDeleted?: boolean; fileId?: string | null }[], files: Record<string, T>): Promise<Record<string, T>> {
  const live = new Set(elements.filter(e => !e.isDeleted).map(e => e.fileId));
  return Object.fromEntries(await Promise.all(Object.entries(files).filter(([id]) => live.has(id)).map(async ([id, file]) => [id, await lightImage(file)])));
}

type Message = { id: string; type: string; isDeleted?: boolean; updated?: number; groupIds?: readonly string[]; containerId?: string | null };
/** The newest written note on the board, his or hers, with the shapes it belongs to (her face, a text box): what opening Love Spot shows, as a chat opens at its last message. */
export function latestMessage<T extends Message>(elements: readonly T[]): T[] {
  const live = elements.filter(e => !e.isDeleted);
  const latest = live.filter(e => e.type === "text").reduce<T | undefined>((best, e) => (e.updated ?? 0) > (best?.updated ?? -1) ? e : best, undefined);
  if (!latest) return [];
  const groups = new Set(latest.groupIds ?? []);
  return live.filter(e => e === latest || e.id === latest.containerId || e.groupIds?.some(id => groups.has(id)));
}
