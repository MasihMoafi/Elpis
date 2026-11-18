/** The delivery marker belongs in the transcript for replay, never in a label. */
export function routerEnvelopeBody(text: string): string | undefined {
  const marker = /^<elpis-router-message id="[^"\r\n]*"(?: includes="[^"\r\n]*")?>/.exec(text);
  return marker ? text.slice(marker[0].length).trim() : undefined;
}

/** Undefined means ordinary text; an empty string means a marker whose payload can't supply a name. */
function routerLabel(text?: string | null): string | undefined {
  if (!text?.startsWith('<elpis-router-message id="')) return undefined;
  const body = routerEnvelopeBody(text);
  if (body === undefined) return text.startsWith('<elpis-router-message id="router%3A') ? "" : undefined;
  let label = body;
  if (body.startsWith("{")) {
    try {
      const value: Record<string, unknown> = JSON.parse(body);
      const field = typeof value.ticket_id === "string" && typeof value.title === "string" ? value.title : value.text;
      label = typeof field === "string" ? field : "";
    } catch {
      return "";
    }
  }
  return label.trim().split(/\r?\n/, 1)[0]!.slice(0, 120);
}

/** Read projection only. An explicit rename wins; the first message can recover a clipped native title. */
export function routerLabels(thread: {
  name?: string | null | undefined;
  preview?: string | null | undefined;
  workflowTaskTitle?: string | undefined;
}) {
  const preview = routerLabel(thread.preview);
  const name = thread.name === thread.preview ? preview : routerLabel(thread.name);
  const label = thread.workflowTaskTitle?.trim() || name || preview || "Message from Elpis";
  return {
    ...(name !== undefined && { name: label }),
    ...(preview !== undefined && { preview: preview || label }),
  };
}
