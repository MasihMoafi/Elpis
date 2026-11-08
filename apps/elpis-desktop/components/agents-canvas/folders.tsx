import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { OptionSelect } from "@/components/ui/option-select";
import { api } from "@/lib/api";
import { WHOLE_PROJECT } from "@/lib/canvas";
import { errorText } from "@/lib/error-text.mts";

/** The folders an agent may write, chosen from the project's own (GET /api/folders) or the whole project, besides the
 * agent's own folder (`ownFolders`), which the run makes and which `own` shows. */
/** The project's folders (GET /api/folders), which agents may write: read once per project, shared by the pickers
 * and by Elpis when it fills in the team. */
export function useProjectFolders(cwd?: string) {
  const [folders, setFolders] = useState<string[] | null>(null),
    [error, setError] = useState("");
  useEffect(() => {
    if (!cwd) return;
    let live = true;
    api<{ data: string[] }>(`/folders?cwd=${encodeURIComponent(cwd)}`)
      .then(result => {
        if (live) {
          setFolders(result.data);
          setError("");
        }
      })
      .catch(cause => {
        if (live) setError(errorText(cause));
      });
    return () => {
      live = false;
    };
  }, [cwd]);
  return { folders, error };
}

export const folderLabel = (folder: string) => (folder === WHOLE_PROJECT ? "Whole project" : folder);

export function FolderPicker({
  cwd,
  folders,
  error,
  value,
  own,
  onChange,
}: {
  cwd?: string | undefined;
  folders: string[] | null;
  error: string;
  value: string[];
  own?: string | undefined;
  onChange: (folders: string[]) => void;
}) {
  const left = (folders ? [WHOLE_PROJECT, ...folders] : []).filter(folder => !value.includes(folder));
  return (
    <div className="canvas-folders" role="group" aria-label="May write">
      <span>May write</span>
      <span className="canvas-folders-chosen">
        {own && (
          <span
            className="canvas-chip"
            title={`${own}: its own folder. The run makes it, and the agent and its check write their reports there.`}
          >
            <span className="canvas-chip-label">{own}</span>
          </span>
        )}
        {value.map(folder => (
          <span key={folder} className="canvas-chip" title={folderLabel(folder)}>
            <span className="canvas-chip-label">{folderLabel(folder)}</span>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={`Remove ${folderLabel(folder)}`}
              onClick={() => onChange(value.filter(item => item !== folder))}
            >
              <X className="size-3" />
            </Button>
          </span>
        ))}
      </span>
      {!cwd ? (
        <small>Agents write inside a project: choose one at the top.</small>
      ) : error ? (
        <small role="alert">{error}</small>
      ) : (
        <OptionSelect
          aria-label="Add a folder"
          value=""
          onChange={event => {
            if (event.target.value) onChange([...value, event.target.value]);
          }}
        >
          <option value="" disabled>
            {folders === null
              ? "Loading the project's folders…"
              : !value.length && folders.length
                ? "Elpis decides, or add a folder…"
                : left.length
                  ? "Add a folder it may write…"
                  : "No more folders"}
          </option>
          {left.map(folder => (
            <option key={folder} value={folder}>
              {folderLabel(folder)}
            </option>
          ))}
        </OptionSelect>
      )}
    </div>
  );
}
