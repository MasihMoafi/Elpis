import { Fragment, useState } from "react";
import type { PromptConfig, PromptsView } from "./api.ts";
import { sectionLabel, type DiffLine } from "./prompt-config.ts";
import { useAction, usePanel } from "./provider.tsx";
import { valueLabel, when } from "./text.ts";
import { Hint } from "./widgets.tsx";
import { Button, Icon } from "./controls.tsx";
import type { Origin } from "./prompts";

export function Diff({ lines }: { lines: DiffLine[] }) {
  const { t } = usePanel();
  return (
    <pre className="dt-pre">
      {lines.map((line, index) => (
        <Fragment key={index}>
          {line.kind === "fold" ? (
            <>
              <span className="dt-diff-fold">{t("promptSameLines", { count: line.count })}</span>
              {"\n"}
            </>
          ) : line.kind === "ins" ? (
            <ins>{`${line.text}\n`}</ins>
          ) : line.kind === "del" ? (
            <del>{`${line.text}\n`}</del>
          ) : (
            `${line.text}\n`
          )}
        </Fragment>
      ))}
    </pre>
  );
}

export function PromptHistory({
  view,
  from,
  onLoad,
}: {
  view: PromptsView;
  from: Origin | undefined;
  onLoad: (config: PromptConfig, from: Origin) => void;
}) {
  const { t, call } = usePanel();
  const [older, setOlder] = useState<Pick<PromptsView, "revisions" | "next_offset">>();
  const next = older ? older.next_offset : view.next_offset;
  const more = useAction(async (offset: number) => {
    const page = await call("GET prompts", { query: { offset } });
    setOlder({ revisions: [...(older?.revisions ?? []), ...page.revisions], next_offset: page.next_offset });
  });
  const load = useAction(async (revision: number) => {
    onLoad((await call("GET prompts", { query: { revision } })).current.config, { revision });
  });
  return (
    <div className="dt-form">
      <Hint>{t("promptHistoryHint")}</Hint>
      <ul className="dt-list">
        {[...view.revisions, ...(older?.revisions ?? [])].map(version => (
          <li key={version.revision} data-slot="settings-row" className="settings-row dt-row">
            <div className="settings-row-text dt-row-main">
              <div className="settings-row-title dt-row-title">
                {t("promptHistoryItem", {
                  revision: version.revision,
                  time: version.savedAt ? when(version.savedAt, t("lang")) : t("promptHistoryInitial"),
                  source: valueLabel(t, "historySource", version.source),
                })}
              </div>
              <div className="settings-row-description dt-row-meta">
                {version.changed.length
                  ? t("promptHistoryChanged", {
                      parts: version.changed.map(name => sectionLabel(t, view, name)).join(t("listSeparator")),
                    })
                  : t("promptHistoryNone")}
              </div>
            </div>
            <div className="dt-row-actions">
              <Button
                variant="outline"
                size="sm"
                icon={<Icon name="history" />}
                disabled={
                  load.busy || (typeof from === "object" && "revision" in from && from.revision === version.revision)
                }
                onClick={() => {
                  void load.run(version.revision);
                }}
              >
                {t("promptRestore")}
              </Button>
            </div>
          </li>
        ))}
      </ul>
      <div className="dt-actions">
        {next !== null && (
          <Button
            variant="outline"
            size="sm"
            icon={<Icon name="chevron-down" />}
            disabled={more.busy}
            onClick={() => {
              void more.run(next);
            }}
          >
            {t("promptOlder")}
          </Button>
        )}
        <Button
          variant="outline"
          size="sm"
          icon={<Icon name="refresh" />}
          onClick={() => onLoad(view.defaults, "defaults")}
        >
          {t("promptDefaults")}
        </Button>
      </div>
      <div className="dt-field">
        <span>{t("promptSessions")}</span>
        {view.sessions.length ? (
          <ul className="dt-changes dt-mono">
            {view.sessions.map(item => (
              <li key={item.sessionId}>
                {t("promptSessionItem", { session: item.sessionId, revision: item.revision })}
              </li>
            ))}
          </ul>
        ) : (
          <Hint>{t("promptNoSessions")}</Hint>
        )}
      </div>
    </div>
  );
}
