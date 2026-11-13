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

/** The keys a server takes from its environment that a person types in: names that read as a key, token or secret, and
 * the OpenRouter key rag and WhisperType need even before one is configured. */
export function keyNames(server: Server) {
  return Array.from(
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
}

const KEY_LABELS: Record<string, string> = {
  OPENROUTER_API_KEY: "OpenRouter key",
  OPENROUTER_API_KEY_COMPANY: "OpenRouter key",
};

/** One field per key, its state in words ("Saved" or "Not saved") and never the key itself (Masih, 13 Nov: the RAG key
 * section was "broken and flickers my screen"). `seen` adds what the server itself reports, such as rag finding its key
 * in its own config. */
export function CredentialSettings({
  server,
  disabled,
  save,
  seen = {},
}: {
  server: Server;
  disabled: boolean;
  save: (body: Record<string, unknown>) => Promise<void>;
  seen?: Record<string, boolean | undefined>;
}) {
  const names = keyNames(server);
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
  const several = names.length > 1;
  return (
    <form
      className="mcp-keys"
      aria-label={`API keys for ${server.name}`}
      onSubmit={event => {
        void submit(event);
      }}
    >
      {names.map(name => {
        const set = !!server.credentials.find(key => key.name === name)?.set || !!seen[name];
        return (
          <label className="field mcp-key" key={name}>
            <span className="mcp-key-name">
              {KEY_LABELS[name] ?? <code>{name}</code>}
              <span className={`key-state ${set ? "set" : "unset"}`}>{set ? "Saved" : "Not saved"}</span>
            </span>
            <Input
              type="password"
              autoComplete="off"
              aria-label={`${server.name} ${name}`}
              value={values[name] ?? ""}
              placeholder={set ? "Paste a new key to replace it" : "Paste the key"}
              disabled={disabled || busy}
              onChange={event => {
                setSaved(false);
                setValues(previous => ({ ...previous, [name]: event.target.value }));
              }}
            />
          </label>
        );
      })}
      <div className="mcp-keys-actions">
        <Button
          type="submit"
          variant="outline"
          disabled={disabled || busy || !Object.values(values).some(value => value.trim())}
        >
          {busy ? "Saving…" : several ? "Save keys" : "Save key"}
        </Button>
        <span role="status" className="text-xs text-muted-foreground">
          {saved ? (several ? "Keys saved." : "Key saved.") : ""}
        </span>
      </div>
    </form>
  );
}

type RagRead = { rag: Rag | null; error: string; answerModels: Model[]; rerankModels: Model[]; rerankError: string };

/** rag's three stages and the two it can change here. Its settings and both model lists are read together and shown at
 * once: shown as each arrived, the card changed height three times while rag's slow doctor ran. */
export function RagSettings({
  version,
  server,
  disabled,
  save: saveKeys,
}: {
  version: string | null;
  server: Server;
  disabled: boolean;
  save: (body: Record<string, unknown>) => Promise<void>;
}) {
  const [read, setRead] = useState<RagRead | null>(null);
  const [error, setError] = useState("");
  const [answer, setAnswer] = useState("");
  const [reranker, setReranker] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let alive = true;
    void Promise.allSettled([
      api<Rag>("/tools/rag"),
      api<{ data: Model[] }>("/models?provider=openrouter"),
      api<{ data: Model[] }>("/models?provider=openrouter&outputModality=rerank"),
    ]).then(([rag, answers, rerankers]) => {
      if (!alive) return;
      const list = (result: PromiseSettledResult<{ data: Model[] }>) =>
        result.status === "fulfilled" && Array.isArray(result.value?.data) ? result.value.data : [];
      setRead(previous => ({
        rag: rag.status === "fulfilled" ? rag.value : (previous?.rag ?? null),
        error: rag.status === "rejected" ? message(rag.reason) : "",
        answerModels: list(answers),
        rerankModels: list(rerankers),
        rerankError: rerankers.status === "rejected" ? message(rerankers.reason) : "",
      }));
    });
    return () => {
      alive = false;
    };
  }, [version]);
  async function save(stage: "generation" | "reranking", model: string) {
    setBusy(true);
    setError("");
    try {
      const rag = await api<Rag>("/tools/rag", { stage, model });
      setRead(previous => (previous ? { ...previous, rag } : previous));
      if (stage === "generation") setAnswer("");
      else setReranker("");
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  const rag = read?.rag ?? null;
  const keys = (
    <CredentialSettings
      server={server}
      disabled={disabled}
      save={saveKeys}
      seen={{ OPENROUTER_API_KEY: rag?.keys.openrouter }}
    />
  );
  if (!read) return <>{keys}<SettingsNotice>Reading RAG settings…</SettingsNotice></>;
  if (!rag)
    return (
      <>
        {keys}
        <SettingsNotice tone="alert">Could not read RAG settings: {read.error}</SettingsNotice>
      </>
    );
  const stage = (id: Stage["stage"]) => rag.stages.find(item => item.stage === id);
  const label = { embedding: "Embedding", reranking: "Reranker", generation: "Answer model" } as const;
  return (
    <>
      {keys}
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
                models={read.answerModels}
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
                models={[...LOCAL_RERANKERS, ...read.rerankModels]}
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
        {read.rerankError && (
          <SettingsNotice tone="alert">Could not list OpenRouter's rerankers: {read.rerankError}</SettingsNotice>
        )}
        {error && <SettingsNotice tone="alert">{error}</SettingsNotice>}
      </div>
    </>
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
