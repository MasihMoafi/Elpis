import { ExperimentLabIcon, LoveSpotIcon, WorkflowsIcon } from "@/components/elpis-icons";
import { Activity, Blocks, Network } from "lucide-react";
import type { View } from "@/lib/workspace-types";

/** The sidebar's pages after New chat, in their default order; the person may rearrange them. */
export const NAV_PAGES = [
  { id: "experimentLab", name: "Lab", Icon: ExperimentLabIcon },
  { id: "canvas", name: "Workflows", Icon: WorkflowsIcon },
  { id: "mother", name: "Mother", Icon: Network },
  { id: "loveSpot", name: "Love Spot", Icon: LoveSpotIcon },
  // 5 Nov: back, as the TUI's /dashboard page (DeepSeek's Trajectory), with the pulse icon he approved.
  { id: "observability", name: "Observability", Icon: Activity },
  { id: "customize", name: "Customize", Icon: Blocks },
] as const;
/** Every page's name, for its heading and the command menu: the sidebar pages, the guide and Settings. */
export const PAGE_NAMES: Record<Exclude<View, "chat">, string> = { ...Object.fromEntries(NAV_PAGES.map(page => [page.id, page.name])) as Record<typeof NAV_PAGES[number]["id"], string>, agentsGuide: "Guide to managing agents", settings: "Settings" };
