"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SettingsNotice } from "@/components/settings/rows";
import { api, type Model } from "@/lib/api";
import { ModelChoice } from "@/components/settings/maintenance";

import type { Server, Stage, Rag } from "./mcp-settings";

import { errorText } from "@/lib/error-text.mts";

export const Key = ({ name, set, note, plain }: { name: string; set: boolean; note?: string; plain?: boolean }) => (
  <li className={`key-state ${set ? "set" : "unset"}`}>
    {plain ? name : <code>{name}</code>} · {set ? "set" : "not set"}
    {note && <span className="text-muted-foreground"> ({note})</span>}
  </li>
);

export function CredentialSettings({
  server,
  disabled,
  save,
}: {
  server: Server;
  disabled: boolean;
  save: (body: Record<string, unknown>) => Promise<void>;
}) {
  const names = Array.from(
    new Set([
      ...server.credentials
        .filter(key =>
          /(?:^|_)(?:API_?KEY|KEY|TOKEN|SECRET|PASSWORD|AUTHORIZATION|CREDENTIALS?)(?:_|$)/i.test(key.name),
        )
        .map(key => key.name),
      ...(server.name === "rag"
        ? ["OPENROUTER_API_KEY"]
        : server.name === "whispertype"
          ? ["OPENROUTER_API_KEY_COMPANY"]
          : []),
    ]),
  );
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setSaved(false);
    try {
      await save({
        action: "credentials",
        env: Object.fromEntries(Object.entries(values).filter(([, value]) => value.trim())),
      });
      setValues({});
      setSaved(true);
    } catch {
    } finally {
      setBusy(false);
    }
  }
  if (!names.length) return null;
  // Elpis gives an HTTP server only the token named by bearer_token_env_var, read from its environment; it refuses `env` there.
  if (server.transport === "http")
    return (
      <p className="text-xs text-muted-foreground">
        This server reads its key from{" "}
        {names.map(name => (
          <code key={name}>{name}</code>
        ))}{" "}
        in the environment Elpis starts with; set it there and restart Elpis.
      </p>
    );
  return (
    <form
      className="mcp-tool-settings settings-form"
      aria-label={`API keys for ${server.name}`}
      onSubmit={event => {
        void submit(event);
      }}
    >
      <div>
        <p className="text-sm font-medium">API keys</p>
        <p className="text-xs text-muted-foreground">
          Leave a field empty to keep its current key. Saved keys are never displayed.
        </p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        {names.map(name => (
          <label className="field min-w-0" key={name}>
            <span className="break-all text-xs">{name}</span>
            <Input
              type="password"
              autoComplete="new-password"
              aria-label={`${server.name} ${name}`}
              value={values[name] ?? ""}
              placeholder={
                server.credentials.find(key => key.name === name)?.set
                  ? "Key is set · enter to replace"
                  : "Enter API key"
              }
              disabled={disabled || busy}
              onChange={event => {
                setSaved(false);
                setValues(previous => ({ ...previous, [name]: event.target.value }));
              }}
            />
          </label>
        ))}
      </div>
      <Button
        type="submit"
        variant="outline"
        className="justify-self-start"
        disabled={disabled || busy || !Object.values(values).some(value => value.trim())}
      >
        {busy ? "Saving…" : "Save API keys"}
      </Button>
      {saved && (
        <p role="status" className="text-xs text-muted-foreground">
          API keys saved.
        </p>
      )}
    </form>
  );
}

export function RagSettings({ version }: { version: string | null }) {
  const [rag, setRag] = useState<Rag | null>(null);
  const [error, setError] = useState("");
  const [answer, setAnswer] = useState("");
  const [reranker, setReranker] = useState("");
  const [busy, setBusy] = useState(false);
  const [answerModels, setAnswerModels] = useState<Model[]>([]);
  const [rerankModels, setRerankModels] = useState<Model[]>([]),
    [rerankError, setRerankError] = useState("");
  useEffect(() => {
    api<Rag>("/tools/rag")
      .then(setRag)
      .catch(e => setError(message(e)));
  }, [version]);
  useEffect(() => {
    api<{ data: Model[] }>("/models?provider=openrouter")
      .then(result => setAnswerModels(Array.isArray(result?.data) ? result.data : []))
      .catch(() => setAnswerModels([]));
  }, []);
  useEffect(() => {
    api<{ data: Model[] }>("/models?provider=openrouter&outputModality=rerank")
      .then(result => {
        setRerankModels(Array.isArray(result?.data) ? result.data : []);
        setRerankError("");
      })
      .catch(e => setRerankError(message(e)));
  }, []);
  async function save(stage: "generation" | "reranking", model: string) {
    setBusy(true);
    setError("");
    try {
      setRag(await api<Rag>("/tools/rag", { stage, model }));
      if (stage === "generation") setAnswer("");
      else setReranker("");
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  if (error && !rag) return <SettingsNotice tone="alert">Could not read RAG settings: {error}</SettingsNotice>;
  if (!rag) return <SettingsNotice>Reading RAG settings…</SettingsNotice>;
  const stage = (id: Stage["stage"]) => rag.stages.find(item => item.stage === id);
  const label = { embedding: "Embedding", reranking: "Reranker", generation: "Answer model" } as const;
  return (
    <div className="grid gap-3">
      <dl className="mcp-values">
        {(["embedding", "reranking", "generation"] as const).map(id => {
          const value = stage(id);
          return (
            <div key={id}>
              <dt>{label[id]}</dt>
              <dd>{value ? `${providerName(value)} · ${value.model ?? "no model"}` : "Not configured"}</dd>
            </div>
          );
        })}
      </dl>
      <ul className="grid gap-1 text-sm">
        <Key name="OpenRouter key" plain set={rag.keys.openrouter} note="as rag sees it" />
      </ul>
      <div className="grid gap-3 sm:grid-cols-2">
        <form
          className="field"
          onSubmit={e => {
            e.preventDefault();
            void save("generation", answer.trim());
          }}
        >
          Change answer model (OpenRouter)
          <div className="flex gap-2">
            <ModelChoice
              label="RAG answer model"
              value={answer || stage("generation")?.model || null}
              models={answerModels}
              provider="OpenRouter"
              disabled={busy}
              onChange={model => setAnswer(model ?? "")}
            />
            <Button
              type="submit"
              variant="outline"
              disabled={busy || !answer.trim() || answer === stage("generation")?.model}
            >
              Save
            </Button>
          </div>
        </form>
        <form
          className="field"
          onSubmit={e => {
            e.preventDefault();
            void save("reranking", reranker.trim());
          }}
        >
          Change reranker
          <div className="flex gap-2">
            <ModelChoice
              label="RAG reranker"
              value={reranker || stage("reranking")?.model || null}
              models={[...LOCAL_RERANKERS, ...rerankModels]}
              provider="OpenRouter"
              disabled={busy}
              onChange={model => setReranker(model ?? "")}
            />
            <Button
              type="submit"
              variant="outline"
              disabled={busy || !reranker.trim() || reranker === stage("reranking")?.model}
            >
              Save
            </Button>
          </div>
        </form>
      </div>
      <p className="provider-note">
        Embeddings change with <code>rag setup</code> because documents are re-indexed. Agents search documents with the{" "}
        <code>rag</code> tool.
      </p>
      {rerankError && (
        <SettingsNotice tone="alert">Could not list OpenRouter's rerankers: {rerankError}</SettingsNotice>
      )}
      {error && <SettingsNotice tone="alert">{error}</SettingsNotice>}
    </div>
  );
}

export const message = (e: unknown) => errorText(e);

/** What the rag tool accepts for its reranker (bridge/tools.mts): off, the local engine, or an OpenRouter reranker ID. */
/** Off and the local reranker, then OpenRouter's own reranker catalogue, read live (29 Oct, Masih: "we want real call and showing of real options"). */
export const LOCAL_RERANKERS: Model[] = (
  [
    ["off", "Off"],
    ["fastembed", "Local (FastEmbed)"],
  ] as const
).map(([model, displayName]) => ({ id: model, model, displayName }));

export const providerName = (stage: Stage) =>
  stage.location === "local"
    ? "Local"
    : stage.provider === "openrouter"
      ? "OpenRouter"
      : stage.provider === "openai_compatible"
        ? "OpenAI-compatible API"
        : (stage.provider ?? "Not set");
