import { useReactFlow, type XYPosition } from "@xyflow/react";
import { type IsoController } from "@/components/agents-iso";
import { MOTHER, type CanvasEdge, type CanvasGraph, type CanvasNode } from "@/lib/canvas";
import type * as React from "react";
import { Adding, MenuAt, BoardMenu } from "./types";
import { MenuItem } from "./menu";

export function canvasMenuItems({
  titleOf,
  removeWire,
  menuAt,
  setFlowEdit,
  openAdder,
  setKind,
  setSelection,
  clipboard,
  checkpoint,
  addNote,
  iso,
  isoController,
  flow,
  paste,
  tidySelection,
  fitAll,
  graph,
  remove,
  mute,
  previewRun,
  frameSelection,
  ungroup,
  copy,
  setDashboardId,
  rename,
  duplicate,
  removeKeepingFlow,
}: {
  titleOf: (id: string) => string;
  removeWire: (id: string) => void;
  menuAt: (event: { clientX: number; clientY: number }, rows: number) => MenuAt | null;
  setFlowEdit: React.Dispatch<React.SetStateAction<{ edge: CanvasEdge; left: number; top: number } | null>>;
  openAdder: (client?: XYPosition, from?: Adding["from"], between?: CanvasEdge, seed?: string) => void;
  setKind: (edge: CanvasEdge, kind: CanvasEdge["kind"]) => void;
  setSelection: React.Dispatch<React.SetStateAction<string[]>>;
  clipboard: React.RefObject<{ nodes: CanvasNode[]; edges: CanvasEdge[]; frames?: CanvasGraph["frames"] } | null>;
  checkpoint: () => void;
  addNote: (at?: XYPosition, text?: string) => void;
  iso: boolean;
  isoController: React.RefObject<IsoController | null>;
  flow: ReturnType<typeof useReactFlow>;
  paste: (at?: XYPosition) => void;
  tidySelection: () => void;
  fitAll: () => void;
  graph: CanvasGraph;
  remove: (ids: string[]) => void;
  mute: (ids?: string[]) => void;
  previewRun: () => void;
  frameSelection: (ids?: string[]) => void;
  ungroup: () => void;
  copy: (ids?: string[]) => void;
  setDashboardId: React.Dispatch<React.SetStateAction<string | null>>;
  rename: () => void;
  duplicate: (ids?: string[]) => void;
  removeKeepingFlow: (ids: string[]) => void;
}) {
  const describe = (count: number, notes: number) =>
    [count && `${count} ${count === 1 ? "agent" : "agents"}`, notes && `${notes} ${notes === 1 ? "note" : "notes"}`]
      .filter(Boolean)
      .join(" and ");
  const menuView = (
    current: BoardMenu,
  ): { name: string; title: string; detail?: string; items: MenuItem[]; onDelete?: (() => void) | undefined } => {
    if (current.kind === "wire") {
      const from = current.edge.source === MOTHER ? null : titleOf(current.edge.source),
        to = titleOf(current.edge.target);
      const removeIt = from ? () => removeWire(current.edge.id) : undefined;
      const sideBySide = current.edge.kind === "alongside";
      return {
        name: "Wire",
        title: "Wire",
        detail: `${from ?? "Mother agent"} ${sideBySide ? "↔" : "→"} ${to}`,
        onDelete: removeIt,
        items: [
          {
            label: "Describe the flow",
            hint: "Name what the receiving agent gets",
            take: () => {
              const at = menuAt({ clientX: current.client.x, clientY: current.client.y }, 1);
              if (at) setFlowEdit({ edge: current.edge, left: at.left, top: at.top });
            },
          },
          ...(sideBySide
            ? []
            : [
                {
                  label: "Insert agents here",
                  hint: from ? `Between ${from} and ${to}` : `Before ${to}, started by the Mother agent`,
                  take: () => openAdder(current.client, undefined, current.edge),
                },
              ]),
          ...(from
            ? [
                sideBySide
                  ? {
                      label: "Make it one-way",
                      hint: `${to} waits for ${from}`,
                      take: () => setKind(current.edge, undefined),
                    }
                  : {
                      label: "Make it two-way",
                      hint: `${from} and ${to} work at the same time, each told about the other`,
                      take: () => setKind(current.edge, "alongside"),
                    },
              ]
            : []),
          ...(removeIt
            ? [
                {
                  label: "Remove wire",
                  hint: sideBySide ? `${from} and ${to} stop working alongside` : `${to} stops waiting for ${from}`,
                  keys: "Delete",
                  take: removeIt,
                },
              ]
            : []),
        ],
      };
    }
    if (current.kind === "mother")
      return {
        name: "Mother agent",
        title: "Mother agent",
        detail: "the run's chat",
        items: [
          { label: "Run settings", hint: "The brief, her model, how many agents", take: () => setSelection([MOTHER]) },
          { label: "Add agents she starts", take: () => openAdder(current.client, { id: MOTHER, as: "target" }) },
        ],
      };
    if (current.kind === "board") {
      const clip = clipboard.current,
        inClip = clip?.nodes.filter(node => node.type === "agent").length ?? 0;
      return {
        name: "Board",
        title: "Board",
        items: [
          { label: "Add agents", keys: "Shift+A / Tab", take: () => openAdder(current.client) },
          {
            label: "Add a note",
            keys: "Shift+S",
            take: () => {
              checkpoint();
              addNote(
                iso ? isoController.current?.position(current.client) : flow.screenToFlowPosition(current.client),
              );
            },
          },
          ...(clip
            ? [
                {
                  label: `Paste ${describe(inClip, clip.nodes.length - inClip)}`,
                  keys: "Ctrl+V",
                  take: () => paste(flow.screenToFlowPosition(current.client)),
                },
              ]
            : []),
          { label: "Arrange by run order", keys: "Shift+Alt+T", take: tidySelection },
          { label: "Fit the view", keys: "Home", take: fitAll },
        ],
      };
    }
    const ids = current.ids,
      picked = graph.nodes.filter(node => ids.includes(node.id)),
      count = picked.filter(node => node.type === "agent").length;
    const removeThem = () => remove(ids);
    const editingItems: MenuItem[] = [
      ...(count
        ? [
            {
              label: picked.some(node => node.type === "agent" && !node.data.muted) ? "Mute" : "Unmute",
              keys: "M",
              hint: "Muted agents are skipped in runs; the drawing stays",
              take: () => mute(ids),
            },
            { label: "Run selected", keys: "Ctrl+Shift+Enter", take: previewRun },
          ]
        : []),
      { label: "Frame selection", keys: "Ctrl+G", take: () => frameSelection(ids) },
      ...(graph.frames?.some(frame => frame.nodeIds.some(id => ids.includes(id)))
        ? [{ label: "Ungroup", keys: "Ctrl+Shift+G", take: ungroup }]
        : []),
      {
        label: "Cut",
        keys: "Ctrl+X",
        take: () => {
          copy(ids);
          remove(ids);
        },
      },
    ];
    const only = picked.length === 1 ? picked[0] : undefined;
    if (only?.type === "agent") {
      return {
        name: `Agent ${only.data.title || "Untitled"}`,
        title: "Agent",
        detail: only.data.title || "Untitled",
        onDelete: removeThem,
        items: [
          { label: "Info", keys: "Enter", take: () => setDashboardId(only.id) },
          { label: "Rename", keys: "F2", take: rename },
          {
            label: "Add agents after it",
            hint: "They wait for it",
            take: () => openAdder(current.client, { id: only.id, as: "target" }),
          },
          { label: "Duplicate", keys: "Ctrl+D", take: () => duplicate(ids) },
          { label: "Copy", keys: "Ctrl+C", take: () => copy(ids) },
          {
            label: "Delete, keep the flow",
            hint: "Reconnect its inputs and outputs across every link kind",
            keys: "Ctrl+Del",
            take: () => removeKeepingFlow(ids),
          },
          { label: "Delete", keys: "Delete", take: removeThem },
        ],
      };
    }
    const what = describe(count, picked.length - count);
    return {
      name: what,
      title: what,
      onDelete: removeThem,
      items: [
        { label: `Duplicate ${what}`, keys: "Ctrl+D", take: () => duplicate(ids) },
        { label: `Copy ${what}`, keys: "Ctrl+C", take: () => copy(ids) },
        ...editingItems,
        ...(count ? [{ label: "Delete, keep the flow", keys: "Ctrl+Del", take: () => removeKeepingFlow(ids) }] : []),
        { label: `Delete ${what}`, keys: "Delete", take: removeThem },
      ],
    };
  };
  return { menuView };
}
