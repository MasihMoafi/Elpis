import type { CanvasController } from "./use-canvas-controller";
import { Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { OptionSelect } from "@/components/ui/option-select";
import { FolderPicker } from "./folders";

export function SelectedAgents({ chosen, shared, choiceKey, edit, modelPatch, mixed, modelOptions, cwd, project, commonFolders, setCommonFolders, remove, setSelection }: Pick<CanvasController, "chosen" | "shared" | "choiceKey" | "edit" | "modelPatch" | "mixed" | "modelOptions" | "cwd" | "project" | "commonFolders" | "setCommonFolders" | "remove" | "setSelection">) {
  return <aside className="canvas-side" aria-label="Selected agents">
      <p className="hud-menu-title">{chosen.length} agents selected</p>
      <p className="canvas-help">{chosen.map(node => node.data.title || "Untitled").join(", ")}</p>
      <label>Model<OptionSelect aria-label="Model" value={shared(choiceKey)} onChange={event => edit(modelPatch(event.target.value))}>{mixed}{modelOptions()}</OptionSelect></label>
      <FolderPicker cwd={cwd} {...project} value={commonFolders} onChange={setCommonFolders} />
      <div className="canvas-inspector-actions">
        <Button variant="ghost" size="sm" className="text-destructive" onClick={() => remove(chosen.map(node => node.id))}><Trash2 size={14} />Delete {chosen.length} agents <kbd>Delete</kbd></Button>
        <Button variant="outline" size="sm" className="ml-auto" onClick={() => setSelection([])}>Done</Button>
      </div>
    </aside>;
}