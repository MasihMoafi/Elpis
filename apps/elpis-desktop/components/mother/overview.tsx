import { Button as SharedButton } from "@/components/ui/button";
// Adapted from DeepSeek dsh-superagent-prototype (MIT), src/client/overview.tsx.
/** Overview page: pending Tickets requiring human action, active system problems, 24-hour flow counts, and Executor load. */
import type { ReactNode } from "react";
import { usePoll, type Problem } from "./api.ts";
import { Button, Icon } from "./controls.tsx";
import { useAction, usePanel, usePanelData } from "./provider.tsx";
import { setupPage, settingsRoute, type Route } from "./route.ts";
import { TicketLine } from "./rows.tsx";
import { healthText, localized, reasonLabel, valueLabel, readableMarkers } from "./text.ts";
import { CheckSetupButton, ConfirmButton, Hint, LoadState, Section, SetupMessage } from "./widgets.tsx";

function ProblemLine({ problem, onChanged }: { problem: Problem; onChanged: () => Promise<void> }) {
  const { t, call, navigate } = usePanel();
  const post = useAction((request: () => Promise<unknown>) => request(), { reload: onChanged });
  const row = (title: string, detail: ReactNode, route: Route | undefined, hint?: string, actions?: ReactNode) => (
    <li data-slot="settings-row" className="settings-row dt-row dt-link dt-att dt-att-error">
      <div className="settings-row-text dt-row-main">
        <div className="dt-att-what">
          {route ? (
            <SharedButton
              variant="link"
              size="content"
              type="button"
              className="dt-open p-0 justify-start text-left max-w-full break-words text-foreground font-medium"
              onClick={() => navigate(route)}
            >
              {title}
            </SharedButton>
          ) : (
            title
          )}
        </div>
        {detail}
        {hint && <Hint>{hint}</Hint>}
        {actions && <div className="settings-row-description dt-row-meta dt-row-buttons">{actions}</div>}
      </div>
    </li>
  );
  const go = (label: string, route: Route) => (
    <Button variant="outline" size="sm" icon={<Icon name="settings" size={14} />} onClick={() => navigate(route)}>
      {label}
    </Button>
  );
  const raw = (text: string | undefined) => text && <p className="dt-error dt-clamp dt-mono">{text}</p>;
  const worded = (text: string) => <p className="dt-error">{text}</p>;
  switch (problem.kind) {
    case "setup":
      return row(
        t("problemSetup"),
        <p className="dt-error">
          <SetupMessage problem={problem} />
        </p>,
        setupPage(problem.place),
        t(`problemSetupFix.${problem.place}`),
        <CheckSetupButton />,
      );
    case "no-source":
      return row(
        t("problemNoSource"),
        undefined,
        settingsRoute("source"),
        undefined,
        go(t("actionOpenSources"), settingsRoute("source")),
      );
    case "no-allowed":
      return row(
        t("problemNoAllowed"),
        undefined,
        settingsRoute("eval"),
        undefined,
        go(t("actionAddAllowed"), settingsRoute("eval")),
      );
    case "executor-paused":
      return row(
        t("problemPaused"),
        undefined,
        { page: "execution" },
        undefined,
        <ConfirmButton
          variant="outline"
          icon="play"
          label={t("resumeProcessing")}
          title={t("resumeProcessing")}
          message={t("resumeProcessingConfirm")}
          onConfirm={async () => {
            await call("POST executor/pause", { body: { paused: false } });
            await onChanged();
          }}
        />,
      );
    case "runtime-error":
      return row(t("problemRuntime", { name: valueLabel(t, "health", problem.name) }), raw(problem.detail), undefined);
    case "source-error": {
      const health = problem.source.health;
      return row(
        t("sourceError", { source: localized(t, problem.source.title) }),
        health.code ? worded(healthText(t, health)) : raw(health.detail),
        { page: "source" },
        t("sourceErrorHint"),
      );
    }
    case "eval-overdue":
      return row(t("problemEvalOverdue", { thread: readableMarkers(t, problem.thread.title) }), undefined, {
        page: "trigger",
        id: problem.thread.key,
      });
    case "eval-unavailable":
      return row(
        t("problemEvalUnavailable", { thread: readableMarkers(t, problem.thread.title) }),
        raw(reasonLabel(t, problem.reason)),
        { page: "trigger", id: problem.thread.key, query: { trigger: problem.triggerId } },
        undefined,
        <>
          <Button
            variant="outline"
            size="sm"
            icon={<Icon name="refresh" size={14} />}
            disabled={post.busy}
            onClick={() => {
              void post.run(() => call("POST triggers/:id/requeue", { id: problem.triggerId }));
            }}
          >
            {t("requeue")}
          </Button>
          <Button
            variant="outline"
            size="sm"
            icon={<Icon name="dismiss" size={14} />}
            disabled={post.busy}
            onClick={() => {
              void post.run(() => call("POST decisions/:id/dismiss", { id: problem.decisionId }));
            }}
          >
            {t("dismiss")}
          </Button>
        </>,
      );
    case "outgoing":
      return row(
        t("problemReply", {
          source: valueLabel(t, "source", problem.outgoing.channel.source),
          attempts: problem.outgoing.attempts,
        }),
        raw(problem.outgoing.error),
        undefined,
      );
  }
}

export function OverviewPage() {
  const { t, call, navigate } = usePanel();
  const { setup } = usePanelData();
  const { data, error, reload } = usePoll(() => call("GET overview"), []);
  if (!data) return <LoadState error={error} loading />;
  const stat = (label: string, value: ReactNode, route?: Route) => (
    <span className="dt-stat">
      <span className="dt-stat-label">{label}</span>
      {route ? (
        <SharedButton
          variant="link"
          size="content"
          type="button"
          className="dt-textlink dt-stat-value p-0 justify-start text-left"
          onClick={() => navigate(route)}
        >
          {value}
        </SharedButton>
      ) : (
        <span className="dt-stat-value">{value}</span>
      )}
    </span>
  );
  const more = (route: Route) => (
    <SharedButton
      variant="link"
      size="content"
      type="button"
      className="dt-textlink dt-more-link p-0 justify-start text-left"
      onClick={() => navigate(route)}
    >
      {t("details")}
    </SharedButton>
  );
  return (
    <>
      {error && <LoadState error={error} loading={false} />}
      <Section title={t("pendingTickets")} count={data.person.length}>
        {data.person.length ? (
          <ul className="dt-list dt-cards">
            {data.person.map(ticket => (
              <TicketLine key={ticket.id} ticket={ticket} question onChanged={reload} />
            ))}
          </ul>
        ) : (
          <Hint>{t("needsYouNone")}</Hint>
        )}
      </Section>
      {data.problems.length > 0 && (
        <Section title={t("problems")} count={data.problems.length}>
          <ul className="dt-list dt-cards">
            {data.problems.map((problem, index) => (
              <ProblemLine key={index} problem={problem} onChanged={reload} />
            ))}
          </ul>
        </Section>
      )}
      <Section title={t("lastDay")} action={more({ page: "trigger", query: { filter: "recent" } })}>
        {/* Received and evaluated counts operate on Triggers rather than Threads or Decisions, so they do not link to filtered views. */}
        <div className="dt-stats">
          {stat(t("flowReceivedLabel"), data.flow.received)}
          {stat(t("flowFilteredLabel"), data.flow.filtered, data.flow.filtered ? { page: "source" } : undefined)}
          {stat(t("flowJudgedLabel"), data.flow.judged)}
          {stat(t("flowAcceptedLabel"), data.flow.accepted, { page: "eval", query: { window: "24h" } })}
          {data.flow.dropped > 0 && stat(t("flowDroppedLabel"), data.flow.dropped, { page: "source" })}
        </div>
      </Section>
      <Section title={t("term.executor")} action={more({ page: "execution" })}>
        {/* Pauses surface in `problems` above, so Executor counts render the same in both states; while setup waits, nothing runs. */}
        {setup?.problem ? (
          <Hint>{t("executorWaitingSetup")}</Hint>
        ) : (
          <div className="dt-stats">
            {stat(t("executingLabel"), `${data.executor.running} / ${data.executor.maxWorkers}`)}
            {stat(t("queuedLabel"), data.executor.queued)}
            {stat(t("idleLabel"), data.executor.idle)}
          </div>
        )}
      </Section>
    </>
  );
}
