import type { CanvasController } from "./use-canvas-controller";
import { DisclosureSummary } from "@/components/ui/disclosure-summary";
import { Background, BackgroundVariant, Controls, MiniMap, ReactFlow } from "@xyflow/react";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { MenuRow } from "@/components/ui/menu-row";
import { IsoBoard } from "@/components/agents-iso";
import { CanvasTextEdit } from "@/components/canvas-text-edit";
import { insidePolygon } from "@/lib/canvas-editing";
import { PATTERNS, FATHER, MOTHER, waits, checkOf, type CanvasEdge } from "@/lib/canvas";
import { over } from "./run-state";
import { FIT, OVERVIEW } from "./constants";
import { NODE_TYPES } from "./nodes";
import { EDGE_TYPES } from "./edges";
import { CommandBar } from "./command-bar";
import { CanvasMenu } from "./menu";
import { AgentDashboard } from "./dashboard";
import { CanvasToolbar } from "./canvas-toolbar";

export function CanvasBoard({ view }: { view: CanvasController }) {
  const {
    setMenu,
    patternCommand,
    found,
    findIndex,
    runTargets,
    start,
    adding,
    menu,
    menuView,
    dashboard,
    flowEdit,
    undoLoad,
  } = view;
  return (
    <div
      className="canvas-board"
      ref={view.board}
      data-tool={view.lasso ? "lasso" : undefined}
      onContextMenuCapture={event => {
        if (view.suppressContext.current || event.ctrlKey) {
          event.preventDefault();
          event.stopPropagation();
        }
      }}
      onPointerDownCapture={event => {
        const target = event.target;
        if (
          !event.isPrimary ||
          !(target instanceof Element) ||
          target.closest(
            "input, textarea, button, [role='dialog'], [role='menu'], .react-flow__controls, .react-flow__minimap, .iso-hud, .canvas-telemetry, .canvas-log-panel, .canvas-toolbar",
          )
        )
          return;
        if (event.button === 2 && (event.ctrlKey || event.metaKey)) {
          view.suppressContext.current = true;
          view.cutter.current = { points: [{ x: event.clientX, y: event.clientY }], ids: new Set() };
          view.setStroke(view.cutter.current.points);
          setMenu(null);
          event.currentTarget.setPointerCapture(event.pointerId);
          event.preventDefault();
          event.stopPropagation();
          return;
        }
        if (event.button !== 0) return;
        const empty =
          target.matches(".react-flow__pane") ||
          (target.closest(".iso-board") &&
            !target.closest(
              ".iso-node, .iso-port, .iso-label, .iso-link, .iso-hud, .iso-flow-label, .canvas-frame-title, .canvas-note",
            ));
        if (!empty) return;
        view.boxDrag.current = {
          x: event.clientX,
          y: event.clientY,
          previous: [...view.selection],
          base: event.shiftKey || event.ctrlKey || event.metaKey || event.altKey ? [...view.selection] : [],
          subtract: event.altKey,
          moved: false,
          lasso: view.lasso,
          points: [{ x: event.clientX, y: event.clientY }],
        };
        event.currentTarget.setPointerCapture(event.pointerId);
        event.preventDefault();
        event.stopPropagation();
        if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
      }}
      onPointerMove={event => {
        view.pointer.current = { x: event.clientX, y: event.clientY };
        const cut = view.cutter.current;
        if (cut?.cancelled) return;
        if (cut) {
          const point = { x: event.clientX, y: event.clientY };
          view.cutCrossed(cut.points.at(-1)!, point);
          cut.points = [...cut.points, point];
          view.setStroke(cut.points);
          return;
        }
        const start = view.boxDrag.current;
        if (!start || (!start.moved && Math.hypot(event.clientX - start.x, event.clientY - start.y) < 5)) return;
        start.moved = true;
        const bounds = event.currentTarget.getBoundingClientRect(),
          left = Math.min(start.x, event.clientX),
          top = Math.min(start.y, event.clientY),
          right = Math.max(start.x, event.clientX),
          bottom = Math.max(start.y, event.clientY),
          crossing = event.clientX < start.x;
        if (start.lasso) {
          start.points = [...start.points, { x: event.clientX, y: event.clientY }];
          view.setStroke(start.points);
        } else
          view.setSelectionBox({
            x: left - bounds.left,
            y: top - bounds.top,
            width: right - left,
            height: bottom - top,
            crossing,
          });
        const picked = [
          ...event.currentTarget.querySelectorAll<HTMLElement | SVGGElement>(
            ".react-flow__node:not(.react-flow__node-father):not(.react-flow__node-frame), .iso-node:not([data-kind='father']), .iso-note",
          ),
        ]
          .filter(node => {
            const box = node.getBoundingClientRect();
            return start.lasso
              ? insidePolygon({ x: box.x + box.width / 2, y: box.y + box.height / 2 }, start.points)
              : crossing
                ? box.left <= right && box.right >= left && box.top <= bottom && box.bottom >= top
                : box.left >= left && box.right <= right && box.top >= top && box.bottom <= bottom;
          })
          .map(node => node.dataset.id!);
        view.setSelection(
          start.subtract ? start.base.filter(id => !picked.includes(id)) : [...new Set([...start.base, ...picked])],
        );
      }}
      onPointerUp={event => {
        const cut = view.cutter.current;
        if (cut) {
          view.cutter.current = null;
          view.setStroke(null);
          if (!cut.cancelled && cut.ids.size) {
            view.checkpoint();
            view.setGraph(current => ({ ...current, edges: current.edges.filter(edge => !cut.ids.has(edge.id)) }));
          }
          if (event.currentTarget.hasPointerCapture(event.pointerId))
            event.currentTarget.releasePointerCapture(event.pointerId);
          setTimeout(() => {
            view.suppressContext.current = false;
          }, 300);
          return;
        }
        const start = view.boxDrag.current;
        if (!start) return;
        view.boxDrag.current = null;
        view.setSelectionBox(null);
        view.setStroke(null);
        view.setLasso(false);
        if (!start.moved) {
          view.setSelection(start.base);
          setMenu(null);
        }
        if (event.currentTarget.hasPointerCapture(event.pointerId))
          event.currentTarget.releasePointerCapture(event.pointerId);
      }}
      onPointerCancel={() => {
        if (view.boxDrag.current) view.setSelection(view.boxDrag.current.previous);
        view.boxDrag.current = null;
        view.cutter.current = null;
        view.setSelectionBox(null);
        view.setStroke(null);
        view.setLasso(false);
        view.suppressContext.current = false;
      }}
      onLostPointerCapture={() => {
        view.boxDrag.current = null;
        view.cutter.current = null;
        view.setSelectionBox(null);
        view.setStroke(null);
      }}
      // A double-click on empty board, whichever layer React Flow put under the pointer, creates an agent there.
      onDoubleClick={event => {
        const target = event.target as Element;
        if (
          (target === event.currentTarget || target.closest(".react-flow")) &&
          !target.closest(
            ".react-flow__node, .react-flow__edge, .react-flow__panel, .react-flow__controls, .react-flow__minimap",
          )
        )
          view.addAgent({ x: event.clientX, y: event.clientY });
      }}
    >
      {view.iso ? (
        <IsoBoard
          workflowIdentity={view.identity}
          graph={view.graph}
          father={view.split.father}
          states={view.states}
          selected={view.selection}
          onSelect={view.setSelection}
          onOpen={view.setDashboardId}
          onRename={view.renameAgent}
          onWireClick={(event, edge) => {
            if (edge.source !== MOTHER && edge.source !== FATHER) view.setSelection([edge.id]);
            view.editFlow(event, edge);
          }}
          dark={view.dark}
          controller={view.isoController}
          modelLabel={view.modelLabel}
          canConnect={view.validConnection}
          inserting={view.insertWire}
          onReconnect={(edge, source, target) => {
            view.connectionCancelled.current = false;
            view.reconnect(edge, source, target);
          }}
          renamingFrame={view.renamingFrame}
          onFrameName={(id, title) => {
            if (title) {
              view.checkpoint();
              view.setGraph(current => ({
                ...current,
                frames: current.frames?.map(frame => (frame.id === id ? { ...frame, title } : frame)),
              }));
            }
            view.setRenamingFrame(null);
            view.focusBoard();
          }}
          onNoteText={view.setText}
          onMoveStart={view.beginDrag}
          onMove={view.moveIso}
          onMoveEnd={(shift, cancel) => {
            if (cancel && view.nodeDrag.current) view.nodeDrag.current.cancelled = true;
            view.finishDrag(shift);
          }}
          onMovePreview={id =>
            view.setInsertWire(view.nodeDrag.current?.extract ? null : (view.insertionAt(id)?.id ?? null))
          }
          onConnect={view.connect}
          onAdd={(at, id, end) =>
            view.addAgent(at, id ? { id, as: end === "source" ? "target" : "source" } : undefined)
          }
          onCommand={(at, id, end) => view.openAdder(at, { id, as: end === "source" ? "target" : "source" })}
          onNodeMenu={(event, id) => {
            const node = view.nodes.find(node => node.id === id);
            if (node) view.onNodeContextMenu(event, node);
          }}
          onBoardMenu={view.onPaneContextMenu}
          onWireMenu={view.onEdgeClick}
        />
      ) : (
        <ReactFlow
          tabIndex={0}
          aria-label="Workflow board"
          nodes={view.nodes}
          edges={view.edges}
          nodeTypes={NODE_TYPES}
          edgeTypes={EDGE_TYPES}
          onNodesChange={view.onNodesChange}
          onEdgesChange={view.onEdgesChange}
          onConnect={({ source, target }) => {
            if (!view.connectionCancelled.current)
              view.connect(source, target, view.alongsideDrag.current ? "alongside" : undefined);
          }}
          onConnectEnd={view.onConnectEnd}
          onConnectStart={event => {
            view.connectionCancelled.current = false;
            view.alongsideDrag.current = "altKey" in event && event.altKey;
            const spot = "touches" in event ? event.touches[0] : event;
            view.connectFrom.current = spot ? { x: spot.clientX, y: spot.clientY } : null;
          }}
          connectOnClick={false}
          onNodeDoubleClick={(_, node) => {
            if (node.type === "agent") view.setDashboardId(node.id);
          }}
          onEdgeClick={(event, edge) => {
            if (edge.source !== MOTHER && edge.source !== FATHER) view.setSelection([edge.id]);
            view.editFlow(event, { id: edge.id, source: edge.source, target: edge.target });
          }}
          onEdgeContextMenu={(event, edge) => {
            event.preventDefault();
            view.onEdgeClick(event, edge);
          }}
          onNodeContextMenu={view.onNodeContextMenu}
          onPaneContextMenu={view.onPaneContextMenu}
          multiSelectionKeyCode={["Shift", "Control", "Meta"]}
          nodeDragThreshold={5}
          nodeClickDistance={5}
          paneClickDistance={5}
          selectionKeyCode={null}
          panOnDrag={[1]}
          panActivationKeyCode={null}
          panOnScroll
          zoomOnScroll={false}
          zoomActivationKeyCode={["Control", "Meta"]}
          snapToGrid
          snapGrid={[20, 20]}
          connectionRadius={32}
          onNodeClick={view.onNodeClick}
          onNodeDragStart={(event, node) => view.beginDrag(node.id, event.altKey)}
          onNodeDrag={(_, node) =>
            view.setInsertWire(view.nodeDrag.current?.extract ? null : (view.insertionAt(node.id)?.id ?? null))
          }
          onNodeDragStop={(event, _, moved) => view.finishDrag(event.shiftKey, moved)}
          onReconnectStart={(_, edge) => {
            view.connectionCancelled.current = false;
            view.reconnecting.current = edge.id;
          }}
          onReconnect={(edge, connection) => view.reconnect(edge as CanvasEdge, connection.source, connection.target)}
          onReconnectEnd={() => {
            view.reconnecting.current = null;
          }}
          isValidConnection={connection =>
            view.validConnection(
              connection.source,
              connection.target,
              view.reconnecting.current,
              view.alongsideDrag.current ||
                view.graph.edges.find(edge => edge.id === view.reconnecting.current)?.kind === "alongside",
            )
          }
          disableKeyboardA11y
          onPaneClick={() => {
            view.setSelection([]);
            setMenu(null);
          }}
          deleteKeyCode={null}
          zoomOnDoubleClick={false}
          colorMode={view.dark ? "dark" : "light"}
          fitView
          fitViewOptions={FIT}
          minZoom={FIT.minZoom}
          proOptions={{ hideAttribution: true }}
        >
          <Background variant={BackgroundVariant.Dots} gap={22} size={1.2} />
          <Controls showInteractive={false} fitViewOptions={OVERVIEW} />
          {view.minimap && <MiniMap pannable zoomable className="canvas-minimap" style={{ width: 150, height: 100 }} />}
        </ReactFlow>
      )}
      {view.stroke && (
        <svg className="canvas-stroke" aria-hidden="true">
          <polyline
            data-tool={view.cutter.current ? "cut" : "lasso"}
            points={view.stroke
              .map(point => {
                const box = view.board.current!.getBoundingClientRect();
                return `${point.x - box.left},${point.y - box.top}`;
              })
              .join(" ")}
          />
        </svg>
      )}
      {view.lasso && (
        <span className="canvas-gesture-hint" role="status">
          Lasso · drag to select · Shift adds · Alt subtracts · Esc cancels
        </span>
      )}
      {view.insertWire && (
        <span className="canvas-gesture-hint" role="status">
          Shift-drop to insert on the highlighted wire · Esc cancels
        </span>
      )}
      {view.selectionBox && (
        <div
          aria-hidden="true"
          className={`canvas-selection absolute pointer-events-none z-10 border ${view.selectionBox.crossing ? "border-dashed border-success bg-success/12" : "border-solid border-primary bg-primary/10"}`}
          style={{
            left: view.selectionBox.x,
            top: view.selectionBox.y,
            width: view.selectionBox.width,
            height: view.selectionBox.height,
          }}
        />
      )}
      {view.run &&
        (view.recordedRun ? (
          <details className="canvas-log-panel" aria-label={over(view.run) ? "Previous attempt" : "Run record"}>
            <DisclosureSummary>
              {over(view.run) ? "Previous attempt" : "Run record"} · {view.run.status} ·{" "}
              {view.savedRecord?.tasks?.filter(task => ["succeeded", "completed"].includes(task.status ?? "")).length ??
                0}
              /{view.savedRecord?.tasks?.length ?? 0} tasks complete
            </DisclosureSummary>
            {view.telemetry}
            {view.historicalNotice && <p className="text-destructive">{view.notice}</p>}
            {view.capturedLog}
          </details>
        ) : (
          <section className="canvas-log-panel" aria-label="Run capture">
            <p className="hud-menu-title">Run log · {view.log.length} events</p>
            {view.capturedLog}
          </section>
        ))}
      {/* Under the board, not floating on it, so it never covers the zoom buttons or the minimap. */}
      <CanvasToolbar addAgent={view.addAgent} addNote={view.addNote} openAdder={view.openAdder} tidy={view.tidy} />
      {view.graph.template === "recursive" && (
        <label className="canvas-round-limit">
          Round limit{" "}
          <Input
            className="w-20"
            type="number"
            aria-label="Round limit"
            min={1}
            max={100}
            value={view.graph.roundLimit ?? ""}
            onChange={event =>
              view.setGraph(current => ({
                ...current,
                roundLimit: event.target.value ? Number(event.target.value) : undefined,
              }))
            }
          />
        </label>
      )}
      {patternCommand !== null && (
        <form
          className="canvas-pattern-command hud-menu"
          aria-label="Workflow command"
          onSubmit={event => {
            event.preventDefault();
            view.patternNumber(patternCommand);
          }}
        >
          <span className="text-xs">{PATTERNS.map((name, index) => `${index + 1} ${name}`).join(" · ")}</span>
          <Input
            aria-label="Workflow pattern"
            autoFocus
            inputMode="numeric"
            value={patternCommand}
            placeholder="Pattern number · Esc cancels"
            onChange={event => {
              view.setPatternCommand(event.target.value);
              if (/^\d$/.test(event.target.value)) view.patternNumber(event.target.value);
            }}
            onKeyDown={event => {
              if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                view.setPatternCommand(null);
                view.board.current?.querySelector<HTMLElement>(".iso-board, .react-flow")?.focus();
              }
            }}
          />
        </form>
      )}
      {view.finding !== null && (
        <div
          className="quick-add hud-menu canvas-search"
          role="dialog"
          aria-label="Find on board"
          onKeyDown={event => {
            if (event.key === "Escape") {
              event.stopPropagation();
              view.setFinding(null);
              view.focusBoard();
            } else if (["ArrowDown", "ArrowUp"].includes(event.key)) {
              event.preventDefault();
              view.setFindIndex(
                index =>
                  (index + (event.key === "ArrowDown" ? 1 : -1) + Math.max(1, found.length)) %
                  Math.max(1, found.length),
              );
            } else if (event.key === "Enter" && found[findIndex]) {
              event.preventDefault();
              view.findAgent(found[findIndex].id);
            }
          }}
        >
          <p className="hud-menu-title">
            Find agents <kbd>Ctrl+F</kbd>
          </p>
          <Input
            autoFocus
            aria-label="Find agents"
            value={view.finding}
            onChange={event => {
              view.setFinding(event.target.value);
              view.setFindIndex(0);
            }}
          />
          <div className="quick-add-list" role="listbox" aria-label="Matching agents">
            {found.map((node, index) => (
              <MenuRow
                role="option"
                aria-selected={index === findIndex}
                key={node.id}
                onClick={() => view.findAgent(node.id)}
              >
                {node.data.title}
                {node.data.muted ? " · muted" : ""}
              </MenuRow>
            ))}
          </div>
          {!found.length && <p className="quick-add-note">No matching agents.</p>}
        </div>
      )}
      {runTargets && (
        <div
          className="quick-add hud-menu canvas-search"
          role="dialog"
          aria-label="Run selected"
          onKeyDown={event => {
            if (event.key === "Escape") {
              event.stopPropagation();
              view.setRunTargets(null);
              view.focusBoard();
            }
          }}
        >
          <p className="hud-menu-title">
            Run selected <kbd>Ctrl+Shift+Enter</kbd>
          </p>
          <p className="quick-add-note">Selected targets and their required ancestors, each with its check:</p>
          <ul className="quick-add-list">
            {view.scope.map(node => (
              <li key={node.id}>
                {node.type === "agent" ? node.data.title : ""} ·{" "}
                {runTargets.includes(node.id) ? "target" : "required ancestor"}
              </li>
            ))}
          </ul>
          <Button
            autoFocus
            size="sm"
            aria-describedby={!view.ready ? view.offlineReasonId : undefined}
            disabled={!view.ready}
            onClick={() => {
              const targets = runTargets;
              view.setRunTargets(null);
              view.focusBoard();
              void start(targets);
            }}
          >
            Run selected
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              view.setRunTargets(null);
              view.focusBoard();
            }}
          >
            Cancel <kbd>Esc</kbd>
          </Button>
        </div>
      )}
      {adding && (
        <CommandBar
          adding={adding}
          room={view.room}
          limit={view.limit}
          catalog={view.catalog}
          providers={view.providers}
          onClose={() => view.setAdding(null)}
          onAgents={command => {
            view.checkpoint();
            view.addAgents(
              Math.max(1, command.count ?? 1),
              {
                model: command.model?.model ?? null,
                provider: command.model?.provider ?? null,
                effort: command.effort,
              },
              adding,
              command.tasks,
            );
            view.setAdding(null);
          }}
          onNote={text => {
            view.checkpoint();
            view.addNote(adding.at, text);
            view.setAdding(null);
          }}
          onAsk={text => {
            view.setAdding(null);
            void view.letElpis(text);
          }}
        />
      )}
      {menu && (view => <CanvasMenu at={menu} {...view} onClose={() => setMenu(null)} />)(menuView(menu))}
      {dashboard && (
        <AgentDashboard
          node={dashboard}
          own={view.own.get(dashboard.id) ?? ""}
          status={view.states[dashboard.id]?.status ?? "idle"}
          check={view.states[checkOf(dashboard.id)]?.status ?? "idle"}
          clash={view.clashes[dashboard.id]}
          chat={view.states[dashboard.id]?.chat ?? null}
          modelLabel={view.modelLabel(dashboard.data)}
          ready={view.ready}
          waitsFor={view.inputsNeeded(dashboard.id)}
          feeds={view.graph.edges
            .filter(edge => waits(edge) && edge.source === dashboard.id)
            .map(edge => view.titleOf(edge.target))}
          onOpenChat={view.onOpenChat}
          onSettings={() => {
            view.setSelection([dashboard.id]);
            view.showPanel(true);
            view.setDashboardId(null);
          }}
          onClose={() => view.setDashboardId(null)}
        />
      )}
      {flowEdit && (
        <div className="canvas-flow-edit" style={{ left: flowEdit.left, top: flowEdit.top }}>
          <CanvasTextEdit
            key={flowEdit.edge.id}
            label="Flow label"
            maxLength={60}
            value={
              flowEdit.edge.source === MOTHER
                ? (view.graph.motherFlow ?? "")
                : (view.graph.edges.find(edge => edge.id === flowEdit.edge.id)?.label ?? "")
            }
            onSave={view.saveFlow}
            onCancel={() => view.setFlowEdit(null)}
          />
        </div>
      )}
      {view.deleted && (
        <p className="canvas-notice" data-tone="info" role="status">
          <span title={`Deleted ${view.deleted}`}>Deleted {view.deleted} ·</span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              view.undo();
              view.board.current?.querySelector<HTMLElement>(".iso-board, .react-flow")?.focus();
            }}
          >
            Undo
          </Button>
        </p>
      )}
      {view.planning && !view.deleted && (
        <p className="canvas-notice" data-tone="info" role="status">
          Elpis is on it: {view.planning.length > 60 ? `${view.planning.slice(0, 60)}…` : view.planning}
        </p>
      )}
      {undoLoad && !view.notice && !view.planning && !view.deleted && (
        <p className="canvas-notice" data-tone="info" role="status">
          Loaded {undoLoad.loaded}.
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              view.setGraph(undoLoad.previous);
              view.setUndoLoad(null);
              setTimeout(() => void view.flow.fitView({ ...FIT, duration: 250 }), 60);
            }}
          >
            Undo
          </Button>
          <Button variant="ghost" size="icon-xs" aria-label="Dismiss" onClick={() => view.setUndoLoad(null)}>
            <X size={13} />
          </Button>
        </p>
      )}
    </div>
  );
}
