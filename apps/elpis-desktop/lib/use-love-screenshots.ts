import type { Dispatch, SetStateAction } from "react";
import { api } from "@/lib/api";
import { errorText } from "@/lib/error-text.mjs";
import { useScreenshotPopup } from "@/lib/use-screenshot-popup";
import type { createWorkspaceVisibility } from "@/lib/workspace-visibility";

/** The screenshot thumbnail adds the shots to the Love Spot page already open, in capture order, then shows it. */
export function useLoveScreenshots(ready: boolean, show: ReturnType<typeof createWorkspaceVisibility>["show"], setError: Dispatch<SetStateAction<string>>) {
  useScreenshotPopup(ready, ids => {
    void (async () => {
      for (const id of ids) await api("/love-spot/screenshots", { id, action: "place" });
      show("loveSpot");
    })().catch(cause => setError(errorText(cause, "The screenshots could not open in Love Spot.")));
  });
}
