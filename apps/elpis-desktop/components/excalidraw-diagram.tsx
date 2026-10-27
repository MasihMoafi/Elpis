"use client";

import { useMemo } from "react";
import { ReplyableImage } from "@/components/image-reply";
import { diagramSvg } from "@/bridge/love-spot-painting.cjs";

/** No raw SVG or external resource is admitted: the shared shape validator owns the image. */
export function ExcalidrawDiagram({ source }: { source: string }) {
  const src = useMemo(() => {
    const svg = diagramSvg(source);
    return svg ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}` : null;
  }, [source]);
  if (!src) return <p className="p-3 text-sm text-muted-foreground" role="status">The diagram is incomplete or could not be rendered.</p>;
  return <ReplyableImage src={src} name="Diagram"><img src={src} alt="Diagram" loading="lazy" /></ReplyableImage>;
}
