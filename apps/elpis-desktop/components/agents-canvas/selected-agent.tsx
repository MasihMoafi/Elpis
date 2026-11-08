import type { CanvasController } from "./use-canvas-controller";
import { ExternalLink, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { OptionSelect } from "@/components/ui/option-select";
import { Textarea } from "@/components/ui/textarea";
import { subscriptionOf } from "@/lib/api";
import { CHECK_LABEL, DONE, STATUS_LABEL, promptName, checkOf, type CanvasNode } from "@/lib/canvas";
import { lines } from "./command-bar";
import { FolderPicker } from "./folders";
import { AgentRunOutput } from "./dashboard";

export function SelectedAgent({
  states,
  selected,
  outputRunId,
  ready,
  nameField,
  promptField,
  edit,
  canonicalProvider,
  subscriptions,
  pendingProviderDefaults,
  catalog,
  providerDefault,
  choices,
  modelLabel,
  choiceKey,
  modelPatch,
  subscriptionOptions,
  modelOptions,
  selectedModel,
  cwd,
  project,
  own,
  dashboardId,
  setDashboardId,
  chat,
  onOpenChat,
  remove,
  setSelection,
}: Pick<
  CanvasController,
  | "states"
  | "outputRunId"
  | "ready"
  | "nameField"
  | "promptField"
  | "edit"
  | "canonicalProvider"
  | "subscriptions"
  | "pendingProviderDefaults"
  | "catalog"
  | "providerDefault"
  | "choices"
  | "modelLabel"
  | "choiceKey"
  | "modelPatch"
  | "subscriptionOptions"
  | "modelOptions"
  | "selectedModel"
  | "cwd"
  | "project"
  | "own"
  | "dashboardId"
  | "setDashboardId"
  | "chat"
  | "onOpenChat"
  | "remove"
  | "setSelection"
> & { selected: Extract<CanvasNode, { type: "agent" }> }) {
  return (
    <aside className="canvas-side" aria-label="Selected agent">
      <p className="hud-menu-title">
        Agent{states[selected.id]?.status ? ` · ${STATUS_LABEL[states[selected.id]?.status ?? "idle"]}` : ""} ·{" "}
        {CHECK_LABEL[states[checkOf(selected.id)]?.status ?? "idle"]}
      </p>
      {outputRunId && (
        <AgentRunOutput
          runId={outputRunId}
          taskId={selected.id}
          working={states[selected.id]?.status === "running"}
          ready={ready}
        />
      )}
      <label>
        Name
        <Input
          ref={nameField}
          aria-label="Name"
          title={selected.data.title}
          value={selected.data.title}
          maxLength={256}
          onKeyDown={event => {
            if (event.key === "Enter") {
              event.preventDefault();
              promptField.current?.focus();
            }
          }}
          onChange={event => edit({ title: event.target.value })}
        />
      </label>
      <label>
        Prompt
        <Textarea
          ref={promptField}
          aria-label="Prompt"
          rows={5}
          value={selected.data.instruction}
          placeholder="What this agent should do; left empty, Elpis fills it from the goal"
          onChange={event =>
            edit({ instruction: event.target.value, title: promptName(selected.data, event.target.value) })
          }
        />
      </label>
      <label>
        Provider
        <OptionSelect
          aria-label="Provider"
          value={subscriptionOf(selected.data.model)?.prefix ?? canonicalProvider(selected.data.provider) ?? ""}
          onChange={event => {
            const subscription = subscriptions.find(choice => choice.id === event.target.value);
            if (subscription) {
              pendingProviderDefaults.current.delete(selected.id);
              edit({ provider: null, model: subscription.models[0]?.model ?? null, effort: null });
              return;
            }
            const provider = event.target.value || null,
              offered = catalog.filter(item => item.provider === provider);
            const keep = offered.find(item => item.model === selected.data.model);
            const preferred = providerDefault(provider);
            if (!offered.length)
              pendingProviderDefaults.current.set(selected.id, {
                provider,
                model: selected.data.model,
                effort: selected.data.effort ?? null,
              });
            else pendingProviderDefaults.current.delete(selected.id);
            edit({
              provider,
              model: keep?.model ?? preferred?.model ?? null,
              effort: keep?.efforts.includes(selected.data.effort ?? "") ? selected.data.effort : null,
            });
          }}
        >
          {choices.map(choice => (
            <option key={choice.id} value={choice.provider ?? ""}>
              {choice.label}
            </option>
          ))}
          {subscriptions.map(choice => (
            <option key={choice.id} value={choice.id}>
              {choice.label}
            </option>
          ))}
        </OptionSelect>
      </label>
      <label>
        Model
        <OptionSelect
          aria-label="Model"
          title={modelLabel(selected.data)}
          value={choiceKey(selected.data)}
          onChange={event => {
            if (event.target.value) {
              pendingProviderDefaults.current.delete(selected.id);
              edit(modelPatch(event.target.value));
              return;
            }
            const provider = canonicalProvider(selected.data.provider),
              fallback = provider ? providerDefault(provider) : undefined;
            if (provider && !fallback)
              pendingProviderDefaults.current.set(selected.id, { provider, model: null, effort: null });
            else pendingProviderDefaults.current.delete(selected.id);
            edit({ provider, model: fallback?.model ?? null, effort: null });
          }}
        >
          {subscriptionOf(selected.data.model)
            ? subscriptionOptions(subscriptionOf(selected.data.model)!.prefix)
            : modelOptions(canonicalProvider(selected.data.provider))}
          {selected.data.model && !selectedModel && !subscriptionOf(selected.data.model) && (
            <option value={choiceKey(selected.data)}>{selected.data.model}</option>
          )}
        </OptionSelect>
      </label>
      {selectedModel && selectedModel.efforts.length > 0 && (
        <label>
          Thinking
          <OptionSelect
            aria-label="Thinking"
            value={selected.data.effort ?? ""}
            onChange={event => edit({ effort: event.target.value || null })}
          >
            <option value="">
              Model default{selectedModel.defaultEffort ? ` (${selectedModel.defaultEffort})` : ""}
            </option>
            {selectedModel.efforts.map(effort => (
              <option key={effort} value={effort}>
                {effort}
              </option>
            ))}
          </OptionSelect>
        </label>
      )}
      <FolderPicker
        cwd={cwd}
        {...project}
        value={selected.data.writeScopes}
        own={own.get(selected.id)}
        onChange={writeScopes => edit({ writeScopes })}
      />
      <label>
        Done when (one per line; its check holds it to these)
        <Textarea
          aria-label="Done when"
          rows={3}
          value={selected.data.acceptanceCriteria.join("\n")}
          placeholder={DONE}
          onChange={event => edit({ acceptanceCriteria: lines(event.target.value) })}
        />
      </label>
      <div className="canvas-inspector-actions">
        <Button
          variant="outline"
          size="sm"
          data-agent-info={selected.id}
          aria-expanded={dashboardId === selected.id}
          onClick={() => setDashboardId(current => (current === selected.id ? null : selected.id))}
        >
          Info <kbd>Enter</kbd>
        </Button>
        {chat && (
          <Button variant="outline" size="sm" onClick={() => onOpenChat(chat)}>
            <ExternalLink size={14} />
            Open its chat
          </Button>
        )}
        <Button variant="ghost" size="sm" className="text-destructive" onClick={() => remove([selected.id])}>
          <Trash2 size={14} />
          Delete agent
        </Button>
        <Button variant="outline" size="sm" className="ml-auto" onClick={() => setSelection([])}>
          Done
        </Button>
      </div>
    </aside>
  );
}
