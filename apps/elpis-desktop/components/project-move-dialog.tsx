"use client";

import { useEffect, useState } from "react";
import { Check } from "lucide-react";
import { FolderIcon } from "@/components/elpis-icons";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
} from "@/components/ui/alert-dialog";
import type { Project } from "@/lib/projects";

/** Where a new chat works, as in the ChatGPT app: the project named in the new-chat heading
 * and the folder chip above the composer open the same menu. A started chat's chip (`label` "Change folder") moves
 * that chat: `addLabel` names the chooser item, and `allowNone` false drops "Don't work in a project". */
export function MoveChatDialog({
  name,
  projects,
  currentId,
  count = 1,
  onMove,
  onClose,
}: {
  name: string | null;
  projects: Project[];
  currentId: string | null | undefined;
  count?: number;
  onMove: (id: string | null) => Promise<void>;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  useEffect(() => {
    setError("");
  }, [name]);
  async function move(id: string | null) {
    setBusy(true);
    setError("");
    try {
      await onMove(id);
      onClose();
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <AlertDialog
      open={name !== null}
      onOpenChange={open => {
        if (!open && !busy) onClose();
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{count > 1 ? `Move ${count} chats to project` : "Move chat to project"}</AlertDialogTitle>
          <AlertDialogDescription>{name}</AlertDialogDescription>
        </AlertDialogHeader>
        <ul className="menu w-full max-h-80 overflow-y-auto p-0">
          {projects.map(project => (
            <li key={project.id}>
              <Button
                variant="ghost"
                className="justify-start"
                disabled={busy || currentId === project.id}
                onClick={() => void move(project.id)}
              >
                <FolderIcon size={14} />
                {project.name}
                {currentId === project.id && <Check size={14} />}
              </Button>
            </li>
          ))}
          <li>
            <Button
              variant="ghost"
              className="justify-start"
              disabled={busy || currentId === null}
              onClick={() => void move(null)}
            >
              No project
            </Button>
          </li>
        </ul>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <AlertDialogFooter>
          <Button variant="outline" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export const message = (e: unknown) =>
  e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") : String(e);
