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

export function CanvasBoard({
  board,
  lasso,
  suppressContext,
  cutter,
  setStroke,
  setMenu,
  boxDrag,
  selection,
  pointer,
  cutCrossed,
  setSelectionBox,
  setSelection,
  checkpoint,
  setGraph,
  setLasso,
  addAgent,
  iso,
  identity,
  graph,
  split,
  states,
  setDashboardId,
  renameAgent,
  editFlow,
  dark,
  isoController,
  modelLabel,
  validConnection,
  insertWire,
  connectionCancelled,
  reconnect,
  renamingFrame,
  setRenamingFrame,
  focusBoard,
  setText,
  beginDrag,
  moveIso,
  nodeDrag,
  finishDrag,
  setInsertWire,
  insertionAt,
  connect,
  openAdder,
  nodes,
  onNodeContextMenu,
  onPaneContextMenu,
  onEdgeClick,
  edges,
  onNodesChange,
  onEdgesChange,
  alongsideDrag,
  onConnectEnd,
  connectFrom,
  onNodeClick,
  reconnecting,
  minimap,
  stroke,
  selectionBox,
  run,
  recordedRun,
  savedRecord,
  telemetry,
  historicalNotice,
  notice,
  capturedLog,
  log,
  addNote,
  tidy,
  patternCommand,
  patternNumber,
  setPatternCommand,
  finding,
  setFinding,
  setFindIndex,
  found,
  findIndex,
  findAgent,
  runTargets,
  setRunTargets,
  scope,
  ready,
  offlineReasonId,
  start,
  adding,
  room,
  limit,
  catalog,
  providers,
  setAdding,
  addAgents,
  letElpis,
  menu,
  menuView,
  dashboard,
  own,
  clashes,
  inputsNeeded,
  titleOf,
  onOpenChat,
  showPanel,
  flowEdit,
  saveFlow,
  setFlowEdit,
  deleted,
  undo,
  planning,
  undoLoad,
  setUndoLoad,
  flow,
}: Pick<
  CanvasController,
  | "board"
  | "lasso"
  | "suppressContext"
  | "cutter"
  | "setStroke"
  | "setMenu"
  | "boxDrag"
  | "selection"
  | "pointer"
  | "cutCrossed"
  | "setSelectionBox"
  | "setSelection"
  | "checkpoint"
  | "setGraph"
  | "setLasso"
  | "addAgent"
  | "iso"
  | "identity"
  | "graph"
  | "split"
  | "states"
  | "setDashboardId"
  | "renameAgent"
  | "editFlow"
  | "dark"
  | "isoController"
  | "modelLabel"
  | "validConnection"
  | "insertWire"
  | "connectionCancelled"
  | "reconnect"
  | "renamingFrame"
  | "setRenamingFrame"
  | "focusBoard"
  | "setText"
  | "beginDrag"
  | "moveIso"
  | "nodeDrag"
  | "finishDrag"
  | "setInsertWire"
  | "insertionAt"
  | "connect"
  | "openAdder"
  | "nodes"
  | "onNodeContextMenu"
  | "onPaneContextMenu"
  | "onEdgeClick"
  | "edges"
  | "onNodesChange"
  | "onEdgesChange"
  | "alongsideDrag"
  | "onConnectEnd"
  | "connectFrom"
  | "onNodeClick"
  | "reconnecting"
  | "minimap"
  | "stroke"
  | "selectionBox"
  | "run"
  | "recordedRun"
  | "savedRecord"
  | "telemetry"
  | "historicalNotice"
  | "notice"
  | "capturedLog"
  | "log"
  | "addNote"
  | "tidy"
  | "patternCommand"
  | "patternNumber"
  | "setPatternCommand"
  | "finding"
  | "setFinding"
  | "setFindIndex"
  | "found"
  | "findIndex"
  | "findAgent"
  | "runTargets"
  | "setRunTargets"
  | "scope"
  | "ready"
  | "offlineReasonId"
  | "start"
  | "adding"
  | "room"
  | "limit"
  | "catalog"
  | "providers"
  | "setAdding"
  | "addAgents"
  | "letElpis"
  | "menu"
  | "menuView"
  | "dashboard"
  | "own"
  | "clashes"
  | "inputsNeeded"
  | "titleOf"
  | "onOpenChat"
  | "showPanel"
  | "flowEdit"
  | "saveFlow"
  | "setFlowEdit"
  | "deleted"
  | "undo"
  | "planning"
  | "undoLoad"
  | "setUndoLoad"
  | "flow"
>) {
  return (
    <div
      className="canvas-board"
      ref={board}
      data-tool={lasso ? "lasso" : undefined}
      onContextMenuCapture={event => {
        if (suppressContext.current || event.ctrlKey) {
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
          suppressContext.current = true;
          cutter.current = { points: [{ x: event.clientX, y: event.clientY }], ids: new Set() };
          setStroke(cutter.current.points);
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
        boxDrag.current = {
          x: event.clientX,
          y: event.clientY,
          previous: [...selection],
          base: event.shiftKey || event.ctrlKey || event.metaKey || event.altKey ? [...selection] : [],
          subtract: event.altKey,
          moved: false,
          lasso,
          points: [{ x: event.clientX, y: event.clientY }],
        };
        event.currentTarget.setPointerCapture(event.pointerId);
        event.preventDefault();
        event.stopPropagation();
        if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
      }}
      onPointerMove={event => {
        pointer.current = { x: event.clientX, y: event.clientY };
        const cut = cutter.current;
        if (cut?.cancelled) return;
        if (cut) {
          const point = { x: event.clientX, y: event.clientY };
          cutCrossed(cut.points.at(-1)!, point);
          cut.points = [...cut.points, point];
          setStroke(cut.points);
          return;
        }
        const start = boxDrag.current;
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
          setStroke(start.points);
        } else
          setSelectionBox({
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
        setSelection(
          start.subtract ? start.base.filter(id => !picked.includes(id)) : [...new Set([...start.base, ...picked])],
        );
      }}
      onPointerUp={event => {
        const cut = cutter.current;
        if (cut) {
          cutter.current = null;
          setStroke(null);
          if (!cut.cancelled && cut.ids.size) {
            checkpoint();
            setGraph(current => ({ ...current, edges: current.edges.filter(edge => !cut.ids.has(edge.id)) }));
          }
          if (event.currentTarget.hasPointerCapture(event.pointerId))
            event.currentTarget.releasePointerCapture(event.pointerId);
          setTimeout(() => {
            suppressContext.current = false;
          }, 300);
          return;
        }
        const start = boxDrag.current;
        if (!start) return;
        boxDrag.current = null;
        setSelectionBox(null);
        setStroke(null);
        setLasso(false);
        if (!start.moved) {
          setSelection(start.base);
          setMenu(null);
        }
        if (event.currentTarget.hasPointerCapture(event.pointerId))
          event.currentTarget.releasePointerCapture(event.pointerId);
      }}
      onPointerCancel={() => {
        if (boxDrag.current) setSelection(boxDrag.current.previous);
        boxDrag.current = null;
        cutter.current = null;
        setSelectionBox(null);
        setStroke(null);
        setLasso(false);
        suppressContext.current = false;
      }}
      onLostPointerCapture={() => {
        boxDrag.current = null;
        cutter.current = null;
        setSelectionBox(null);
        setStroke(null);
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
          addAgent({ x: event.clientX, y: event.clientY });
      }}
    >
      {iso ? (
        <IsoBoard
          workflowIdentity={identity}
          graph={graph}
          father={split.father}
          states={states}
          selected={selection}
          onSelect={setSelection}
          onOpen={setDashboardId}
          onRename={renameAgent}
          onWireClick={(event, edge) => {
            if (edge.source !== MOTHER && edge.source !== FATHER) setSelection([edge.id]);
            editFlow(event, edge);
          }}
          dark={dark}
          controller={isoController}
          modelLabel={modelLabel}
          canConnect={validConnection}
          inserting={insertWire}
          onReconnect={(edge, source, target) => {
            connectionCancelled.current = false;
            reconnect(edge, source, target);
          }}
          renamingFrame={renamingFrame}
          onFrameName={(id, title) => {
            if (title) {
              checkpoint();
              setGraph(current => ({
                ...current,
                frames: current.frames?.map(frame => (frame.id === id ? { ...frame, title } : frame)),
              }));
            }
            setRenamingFrame(null);
            focusBoard();
          }}
          onNoteText={setText}
          onMoveStart={beginDrag}
          onMove={moveIso}
          onMoveEnd={(shift, cancel) => {
            if (cancel && nodeDrag.current) nodeDrag.current.cancelled = true;
            finishDrag(shift);
          }}
          onMovePreview={id => setInsertWire(nodeDrag.current?.extract ? null : (insertionAt(id)?.id ?? null))}
          onConnect={connect}
          onAdd={(at, id, end) => addAgent(at, id ? { id, as: end === "source" ? "target" : "source" } : undefined)}
          onCommand={(at, id, end) => openAdder(at, { id, as: end === "source" ? "target" : "source" })}
          onNodeMenu={(event, id) => {
            const node = nodes.find(node => node.id === id);
            if (node) onNodeContextMenu(event, node);
          }}
          onBoardMenu={onPaneContextMenu}
          onWireMenu={onEdgeClick}
        />
      ) : (
        <ReactFlow
          tabIndex={0}
          aria-label="Workflow board"
          nodes={nodes}
          edges={edges}
          nodeTypes={NODE_TYPES}
          edgeTypes={EDGE_TYPES}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={({ source, target }) => {
            if (!connectionCancelled.current) connect(source, target, alongsideDrag.current ? "alongside" : undefined);
          }}
          onConnectEnd={onConnectEnd}
          onConnectStart={event => {
            connectionCancelled.current = false;
            alongsideDrag.current = "altKey" in event && event.altKey;
            const spot = "touches" in event ? event.touches[0] : event;
            connectFrom.current = spot ? { x: spot.clientX, y: spot.clientY } : null;
          }}
          connectOnClick={false}
          onNodeDoubleClick={(_, node) => {
            if (node.type === "agent") setDashboardId(node.id);
          }}
          onEdgeClick={(event, edge) => {
            if (edge.source !== MOTHER && edge.source !== FATHER) setSelection([edge.id]);
            editFlow(event, { id: edge.id, source: edge.source, target: edge.target });
          }}
          onEdgeContextMenu={(event, edge) => {
            event.preventDefault();
            onEdgeClick(event, edge);
          }}
          onNodeContextMenu={onNodeContextMenu}
          onPaneContextMenu={onPaneContextMenu}
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
          onNodeClick={onNodeClick}
          onNodeDragStart={(event, node) => beginDrag(node.id, event.altKey)}
          onNodeDrag={(_, node) => setInsertWire(nodeDrag.current?.extract ? null : (insertionAt(node.id)?.id ?? null))}
          onNodeDragStop={(event, _, moved) => finishDrag(event.shiftKey, moved)}
          onReconnectStart={(_, edge) => {
            connectionCancelled.current = false;
            reconnecting.current = edge.id;
          }}
          onReconnect={(edge, connection) => reconnect(edge as CanvasEdge, connection.source, connection.target)}
          onReconnectEnd={() => {
            reconnecting.current = null;
          }}
          isValidConnection={connection =>
            validConnection(
              connection.source,
              connection.target,
              reconnecting.current,
              alongsideDrag.current || graph.edges.find(edge => edge.id === reconnecting.current)?.kind === "alongside",
            )
          }
          disableKeyboardA11y
          onPaneClick={() => {
            setSelection([]);
            setMenu(null);
          }}
          deleteKeyCode={null}
          zoomOnDoubleClick={false}
          colorMode={dark ? "dark" : "light"}
          fitView
          fitViewOptions={FIT}
          minZoom={FIT.minZoom}
          proOptions={{ hideAttribution: true }}
        >
          <Background variant={BackgroundVariant.Dots} gap={22} size={1.2} />
          <Controls showInteractive={false} fitViewOptions={OVERVIEW} />
          {minimap && <MiniMap pannable zoomable className="canvas-minimap" style={{ width: 150, height: 100 }} />}
        </ReactFlow>
      )}
      {stroke && (
        <svg className="canvas-stroke" aria-hidden="true">
          <polyline
            data-tool={cutter.current ? "cut" : "lasso"}
            points={stroke
              .map(point => {
                const box = board.current!.getBoundingClientRect();
                return `${point.x - box.left},${point.y - box.top}`;
              })
              .join(" ")}
          />
        </svg>
      )}
      {lasso && (
        <span className="canvas-gesture-hint" role="status">
          Lasso · drag to select · Shift adds · Alt subtracts · Esc cancels
        </span>
      )}
      {insertWire && (
        <span className="canvas-gesture-hint" role="status">
          Shift-drop to insert on the highlighted wire · Esc cancels
        </span>
      )}
      {selectionBox && (
        <div
          aria-hidden="true"
          className={`canvas-selection absolute pointer-events-none z-10 border ${selectionBox.crossing ? "border-dashed border-success bg-success/12" : "border-solid border-primary bg-primary/10"}`}
          style={{ left: selectionBox.x, top: selectionBox.y, width: selectionBox.width, height: selectionBox.height }}
        />
      )}
      {run &&
        (recordedRun ? (
          <details className="canvas-log-panel" aria-label={over(run) ? "Previous attempt" : "Run record"}>
            <DisclosureSummary>
              {over(run) ? "Previous attempt" : "Run record"} · {run.status} ·{" "}
              {savedRecord?.tasks?.filter(task => ["succeeded", "completed"].includes(task.status ?? "")).length ?? 0}/
              {savedRecord?.tasks?.length ?? 0} tasks complete
            </DisclosureSummary>
            {telemetry}
            {historicalNotice && <p className="text-destructive">{notice}</p>}
            {capturedLog}
          </details>
        ) : (
          <section className="canvas-log-panel" aria-label="Run capture">
            <p className="hud-menu-title">Run log · {log.length} events</p>
            {capturedLog}
          </section>
        ))}
      {/* Under the board, not floating on it, so it never covers the zoom buttons or the minimap. */}
      <CanvasToolbar addAgent={addAgent} addNote={addNote} openAdder={openAdder} tidy={tidy} />
      {graph.template === "recursive" && (
        <label className="canvas-round-limit">
          Round limit{" "}
          <Input
            className="w-20"
            type="number"
            aria-label="Round limit"
            min={1}
            max={100}
            value={graph.roundLimit ?? ""}
            onChange={event =>
              setGraph(current => ({
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
            patternNumber(patternCommand);
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
              setPatternCommand(event.target.value);
              if (/^\d$/.test(event.target.value)) patternNumber(event.target.value);
            }}
            onKeyDown={event => {
              if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                setPatternCommand(null);
                board.current?.querySelector<HTMLElement>(".iso-board, .react-flow")?.focus();
              }
            }}
          />
        </form>
      )}
      {finding !== null && (
        <div
          className="quick-add hud-menu canvas-search"
          role="dialog"
          aria-label="Find on board"
          onKeyDown={event => {
            if (event.key === "Escape") {
              event.stopPropagation();
              setFinding(null);
              focusBoard();
            } else if (["ArrowDown", "ArrowUp"].includes(event.key)) {
              event.preventDefault();
              setFindIndex(
                index =>
                  (index + (event.key === "ArrowDown" ? 1 : -1) + Math.max(1, found.length)) %
                  Math.max(1, found.length),
              );
            } else if (event.key === "Enter" && found[findIndex]) {
              event.preventDefault();
              findAgent(found[findIndex].id);
            }
          }}
        >
          <p className="hud-menu-title">
            Find agents <kbd>Ctrl+F</kbd>
          </p>
          <Input
            autoFocus
            aria-label="Find agents"
            value={finding}
            onChange={event => {
              setFinding(event.target.value);
              setFindIndex(0);
            }}
          />
          <div className="quick-add-list" role="listbox" aria-label="Matching agents">
            {found.map((node, index) => (
              <MenuRow
                role="option"
                aria-selected={index === findIndex}
                key={node.id}
                onClick={() => findAgent(node.id)}
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
              setRunTargets(null);
              focusBoard();
            }
          }}
        >
          <p className="hud-menu-title">
            Run selected <kbd>Ctrl+Shift+Enter</kbd>
          </p>
          <p className="quick-add-note">Selected targets and their required ancestors, each with its check:</p>
          <ul className="quick-add-list">
            {scope.map(node => (
              <li key={node.id}>
                {node.type === "agent" ? node.data.title : ""} ·{" "}
                {runTargets.includes(node.id) ? "target" : "required ancestor"}
              </li>
            ))}
          </ul>
          <Button
            autoFocus
            size="sm"
            aria-describedby={!ready ? offlineReasonId : undefined}
            disabled={!ready}
            onClick={() => {
              const targets = runTargets;
              setRunTargets(null);
              focusBoard();
              void start(targets);
            }}
          >
            Run selected
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setRunTargets(null);
              focusBoard();
            }}
          >
            Cancel <kbd>Esc</kbd>
          </Button>
        </div>
      )}
      {adding && (
        <CommandBar
          adding={adding}
          room={room}
          limit={limit}
          catalog={catalog}
          providers={providers}
          onClose={() => setAdding(null)}
          onAgents={command => {
            checkpoint();
            addAgents(
              Math.max(1, command.count ?? 1),
              {
                model: command.model?.model ?? null,
                provider: command.model?.provider ?? null,
                effort: command.effort,
              },
              adding,
              command.tasks,
            );
            setAdding(null);
          }}
          onNote={text => {
            checkpoint();
            addNote(adding.at, text);
            setAdding(null);
          }}
          onAsk={text => {
            setAdding(null);
            void letElpis(text);
          }}
        />
      )}
      {menu && (view => <CanvasMenu at={menu} {...view} onClose={() => setMenu(null)} />)(menuView(menu))}
      {dashboard && (
        <AgentDashboard
          node={dashboard}
          own={own.get(dashboard.id) ?? ""}
          status={states[dashboard.id]?.status ?? "idle"}
          check={states[checkOf(dashboard.id)]?.status ?? "idle"}
          clash={clashes[dashboard.id]}
          chat={states[dashboard.id]?.chat ?? null}
          modelLabel={modelLabel(dashboard.data)}
          ready={ready}
          waitsFor={inputsNeeded(dashboard.id)}
          feeds={graph.edges
            .filter(edge => waits(edge) && edge.source === dashboard.id)
            .map(edge => titleOf(edge.target))}
          onOpenChat={onOpenChat}
          onSettings={() => {
            setSelection([dashboard.id]);
            showPanel(true);
            setDashboardId(null);
          }}
          onClose={() => setDashboardId(null)}
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
                ? (graph.motherFlow ?? "")
                : (graph.edges.find(edge => edge.id === flowEdit.edge.id)?.label ?? "")
            }
            onSave={saveFlow}
            onCancel={() => setFlowEdit(null)}
          />
        </div>
      )}
      {deleted && (
        <p className="canvas-notice" data-tone="info" role="status">
          <span title={`Deleted ${deleted}`}>Deleted {deleted} ·</span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              undo();
              board.current?.querySelector<HTMLElement>(".iso-board, .react-flow")?.focus();
            }}
          >
            Undo
          </Button>
        </p>
      )}
      {planning && !deleted && (
        <p className="canvas-notice" data-tone="info" role="status">
          Elpis is on it: {planning.length > 60 ? `${planning.slice(0, 60)}…` : planning}
        </p>
      )}
      {undoLoad && !notice && !planning && !deleted && (
        <p className="canvas-notice" data-tone="info" role="status">
          Loaded {undoLoad.loaded}.
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setGraph(undoLoad.previous);
              setUndoLoad(null);
              setTimeout(() => void flow.fitView({ ...FIT, duration: 250 }), 60);
            }}
          >
            Undo
          </Button>
          <Button variant="ghost" size="icon-xs" aria-label="Dismiss" onClick={() => setUndoLoad(null)}>
            <X size={13} />
          </Button>
        </p>
      )}
    </div>
  );
}
