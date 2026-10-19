"use client";

import { useEffect, useRef, useState } from "react";
import { Eye, EyeOff, Send, SquareDashedMousePointer, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { AlertDialog, AlertDialogClose, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import type { Attachment } from "@/lib/attachments";
import type { Browser } from "@/components/browser-panel";

/** Gives comments to the chat: adds them to the composer and, for Send, sends the message. False when they could not be added. */
export type AttachToChat = (parts: Attachment[], submit: boolean) => Promise<boolean>;

const BLUE = "#2f6fed";
const IMAGE_LIMIT = 3.8 * 1024 * 1024;
const load = (src: string) => new Promise<HTMLImageElement>((resolve, reject) => { const image = new Image(); image.onload = () => resolve(image); image.onerror = () => reject(Error("A screenshot could not be read.")); image.src = src; });
const bytes = (dataUrl: string) => Math.ceil((dataUrl.length - dataUrl.indexOf(",") - 1) * 3 / 4);

/** One JPEG for the agent: each comment's screenshot under a "Comment N" header, two per row. */
export async function screenshotSheet(images: { number: number; dataUrl: string }[]): Promise<string> {
  const loaded = await Promise.all(images.map(async item => ({ number: item.number, image: await load(item.dataUrl) })));
  const columns = loaded.length > 1 ? 2 : 1, width = columns > 1 ? 800 : Math.min(1280, loaded[0].image.naturalWidth), header = 30, gap = 8;
  const heights = loaded.map(item => header + Math.round(item.image.naturalHeight * width / item.image.naturalWidth));
  const rows: number[] = []; for (let index = 0; index < loaded.length; index += columns) rows.push(Math.max(...heights.slice(index, index + columns)));
  const canvas = document.createElement("canvas");
  canvas.width = columns * width + (columns + 1) * gap; canvas.height = rows.reduce((sum, row) => sum + row + gap, gap);
  const context = canvas.getContext("2d"); if (!context) throw Error("Screenshots cannot be combined on this computer.");
  context.fillStyle = "#e9e9ec"; context.fillRect(0, 0, canvas.width, canvas.height);
  let y = gap;
  rows.forEach((row, rowIndex) => {
    loaded.slice(rowIndex * columns, rowIndex * columns + columns).forEach((item, column) => {
      const x = gap + column * (width + gap), height = heights[rowIndex * columns + column] - header;
      context.fillStyle = BLUE; context.fillRect(x, y, width, header);
      context.fillStyle = "#fff"; context.font = "600 16px system-ui, sans-serif"; context.textBaseline = "middle"; context.fillText(`Comment ${item.number}`, x + 10, y + header / 2);
      context.drawImage(item.image, x, y + header, width, height);
    });
    y += row + gap;
  });
  for (const quality of [0.85, 0.7, 0.55, 0.4]) { const url = canvas.toDataURL("image/jpeg", quality); if (bytes(url) <= IMAGE_LIMIT) return url; }
  throw Error("The screenshots are too large to send together. Send fewer comments at once.");
}

/** Annotation mode's place in Elpis: the comment being written and the pending ones, below the page.
 * The ChatGPT app floats these over the page; here they sit outside it, so the page cannot read what is typed. */
export function AnnotationDock({ browser, onAttach, imagesAllowed }: { browser: Browser; onAttach?: AttachToChat; imagesAllowed: boolean }) {
  const { state, command } = browser;
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [discarding, setDiscarding] = useState(false);
  const field = useRef<HTMLTextAreaElement>(null);
  const draft = state?.draft ?? null, comments = state?.annotations ?? [];
  const draftKey = draft ? `${draft.id}:${draft.editing}` : "";
  // A new selection keeps what was typed; opening a saved comment shows its text.
  useEffect(() => { if (!draft) return; if (draft.editing) setBody(draft.body); field.current?.focus(); }, [draftKey]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (!draft) setBody(""); }, [!!draft]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!state || !state.annotating && !comments.length) return null;
  const save = async () => { if (!body.trim()) return false; setError(""); await command("comment", { body }); setBody(""); return true; };
  async function send(submit: boolean) {
    if (!onAttach || busy) return;
    setBusy(true); setError("");
    try {
      if (draft && body.trim() && !await save()) return;
      const response = await browser.command("annotationsCollect", { value: imagesAllowed ? "images" : "text" });
      const result = response?.result; if (!result?.count || !result.text) { setError("Write a comment before sending."); return; }
      const parts: Attachment[] = [{ id: crypto.randomUUID(), name: "Browser comments", type: "text", mimeType: "text/plain", text: result.text }];
      if (result.images?.length) parts.push({ id: crypto.randomUUID(), name: "Browser comments.jpg", type: "image", mimeType: "image/jpeg", dataUrl: await screenshotSheet(result.images) });
      if (await onAttach(parts, submit)) await command("annotationsSent");
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }
  const count = comments.length;
  return <div className="annotation-dock" aria-label="Browser annotations" onKeyDown={event => { if (event.key === "Escape" && !draft) { event.preventDefault(); void command("annotate", { value: false }); } }}>
    {state.annotating && <form className="annotation-editor" aria-label={draft ? `Comment ${draft.number}` : "Annotate this page"} onSubmit={event => { event.preventDefault(); void save(); }}>
      {draft ? <>
        <span className="annotation-target" title={draft.label}><b>{draft.number}</b>{draft.label}</span>
        <Textarea ref={field} aria-label="Comment" placeholder="Add a comment…" value={body} rows={2} onChange={event => setBody(event.target.value)}
          onKeyDown={event => {
            if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); void command("commentCancel"); }
            // Enter sends, as in the chat box (this comment and any pending ones); Ctrl+Enter keeps it to add another.
            else if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) { event.preventDefault(); void save(); }
            else if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(true); }
          }} />
        <div className="annotation-editor-actions">
          <Button type="button" variant="ghost" size="sm" onClick={() => void command("commentCancel")}>Cancel</Button>
          {draft.editing && <Button type="button" variant="ghost" size="sm" onClick={() => void command("commentDelete", { id: draft.id })}>Delete</Button>}
          <Button type="submit" size="sm" disabled={!body.trim()} title="Enter sends · Ctrl+Enter keeps it and adds another">{draft.editing ? "Save" : "Comment"}</Button>
        </div>
      </> : <p className="annotation-hint"><SquareDashedMousePointer size={15} aria-hidden="true" />Click anything on the page to comment on it, or drag to select an area. Hold <kbd>Space</kbd> to use the page.</p>}
    </form>}
    <div className="annotation-bar">
      <span className="annotation-status">{state.annotating ? <><i aria-hidden="true" />Annotating</> : "Annotations"}{count > 0 && ` · ${count}`}</span>
      <ol className="annotation-chips" aria-label="Pending comments">
        {comments.map(item => <li key={item.id}><button type="button" aria-label={`Edit comment ${item.number}: ${item.label}`} title={`${item.label}\n${item.body}`} aria-pressed={draft?.editing && draft.id === item.id || undefined}
          onClick={() => { if (!state.annotating) void command("annotate", { value: true }).then(() => command("commentEdit", { id: item.id })); else void command("commentEdit", { id: item.id }); }}>{item.number}</button></li>)}
      </ol>
      {error && <span role="alert" className="annotation-error">{error}</span>}
      <Button type="button" variant="ghost" size="icon-sm" aria-label={state.markersVisible ? "Hide markers" : "Show markers"} title={state.markersVisible ? "Hide markers" : "Show markers"} aria-pressed={!state.markersVisible} onClick={() => void command("markers")}>{state.markersVisible ? <Eye size={15} /> : <EyeOff size={15} />}</Button>
      <Button type="button" variant="ghost" size="icon-sm" aria-label="Discard annotations" title="Discard annotations" disabled={!count && !draft} onClick={() => setDiscarding(true)}><Trash2 size={15} /></Button>
      {state.annotating
        ? <Button type="button" variant="ghost" size="icon-sm" aria-label="Exit annotation mode" title="Exit annotation mode (comments are kept)" onClick={() => void command("annotate", { value: false })}><X size={15} /></Button>
        : <Button type="button" variant="ghost" size="sm" onClick={() => void command("annotate", { value: true })}>Continue</Button>}
      <Button type="button" variant="outline" size="sm" disabled={!count || busy || !onAttach} title="Add the comments to your message without sending it" onClick={() => void send(false)}>Add to message</Button>
      <Button type="button" size="sm" disabled={!count || busy || !onAttach} aria-label={count ? `Send ${count} pending ${count === 1 ? "annotation" : "annotations"}` : "Send"} onClick={() => void send(true)}><Send size={14} />Send{count ? ` ${count}` : ""}</Button>
    </div>
    <AlertDialog open={discarding} onOpenChange={setDiscarding}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Discard all pending annotations?</AlertDialogTitle>
          <AlertDialogDescription>Every comment on this page is removed.</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogClose render={<Button type="button" variant="outline" />}>Cancel</AlertDialogClose>
          <Button type="button" variant="destructive" onClick={() => { setDiscarding(false); void command("annotationsDiscard"); }}>Discard</Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </div>;
}
