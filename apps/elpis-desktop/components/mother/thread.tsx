import { Button as SharedButton } from "@/components/ui/button";
// Adapted from DeepSeek dsh-superagent-prototype (MIT), src/client/thread.tsx.
/** Thread detail page: Trigger timeline with gap-free pagination, Decisions, subscribed Tickets, and correlated Threads. */
import { useEffect, useState, type ReactNode } from "react";
import { ApiError, usePoll, type ThreadPageView, type TriggerRow } from "./api.ts";
import { Button, DisclosureRow, Icon, Tag } from "./controls.tsx";
import { decisionMark } from "./marks.ts";
import { useAction, usePanel } from "./provider.tsx";
import { DecisionLine, Earlier, TicketLine, automatedRuns } from "./rows.tsx";
import { actorName, errorText, readableMarkers, reasonLabel, valueLabel, when, type T } from "./text.ts";
import { ActionLink, ClampText, ConfirmButton, Empty, Hint, LoadState, PageHead, Section, When } from "./widgets.tsx";

/** Disposition tags for a Trigger; omits `ignore` (the common case) and suppresses fanout tags when every target Ticket is already listed in `subscribed`. */
function triggerTags(t: T, trigger: TriggerRow, subscribed?: Set<string>): ReactNode {
  const d = trigger.disposition;
  const tags: ReactNode[] = [];
  if (d.queued)
    tags.push(
      <Tag key="q" tone="info">
        {t("dispositionQueued")}
      </Tag>,
    );
  else if (d.evaluating)
    tags.push(
      <Tag key="e" tone="info">
        {t("dispositionEvaluating")}
      </Tag>,
    );
  else if (d.filtered)
    tags.push(
      <Tag key="f" tone="neutral">
        {t("tagFiltered", { reason: reasonLabel(t, d.filtered) })}
      </Tag>,
    );
  else if (d.decision && d.decision.outcome !== "ignore") {
    const { tone, label } = decisionMark(t, d.decision.outcome);
    tags.push(
      <Tag key="d" tone={tone}>
        {label}
      </Tag>,
    );
  }
  if (d.delivered)
    tags.push(
      <Tag key="o" tone="info" title={t("dispositionDeliveredHint")}>
        {t("dispositionDelivered")}
      </Tag>,
    );
  else if (d.fanout.length && !(subscribed && d.fanout.every(id => subscribed.has(id))))
    tags.push(
      <Tag key="o" tone="info">
        {t("dispositionFanout", { count: d.fanout.length })}
      </Tag>,
    );
  return tags;
}

function TriggerItem({
  trigger,
  earlier,
  target,
  subscribed,
  requeue,
}: {
  trigger: TriggerRow;
  earlier: TriggerRow[];
  target: string | undefined;
  subscribed: Set<string>;
  requeue: { busy: boolean; run: () => void } | undefined;
}) {
  const { t, navigate } = usePanel();
  const ticketId = trigger.disposition.decision?.ticketId;
  const scroll = (element: HTMLLIElement | null) => {
    if (element && target === trigger.id && !element.dataset.scrolled) {
      element.dataset.scrolled = "1";
      element.scrollIntoView?.({ block: "center" });
    }
  };
  return (
    <li
      id={`trigger-${trigger.id}`}
      className={`dt-event${target === trigger.id ? " dt-highlight" : ""}${trigger.human ? "" : " dt-event-quiet"}`}
      ref={scroll}
    >
      <div className="dt-event-foot">
        <strong className="dt-event-actor">{actorName(t, trigger.actor)}</strong>
        <When at={trigger.at} />
      </div>
      <ClampText text={readableMarkers(t, trigger.text || trigger.preview)} />
      <Earlier items={earlier} />
      {trigger.disposition.handbacks.map(item => (
        <Hint key={item.ticketId}>{t("handedBack", { ticket: item.title, reason: item.reason })}</Hint>
      ))}
      <div className="dt-event-foot">
        {triggerTags(t, trigger, subscribed)}
        {ticketId && !subscribed.has(ticketId) && (
          <SharedButton
            variant="link"
            size="content"
            type="button"
            className="dt-textlink dt-icon-link p-0 justify-start text-left"
            onClick={() => navigate({ page: "execution", id: ticketId })}
          >
            {t("openTicket")}
          </SharedButton>
        )}
        {requeue && (
          <SharedButton
            variant="link"
            size="content"
            type="button"
            className="dt-textlink dt-icon-link dt-reveal p-0 justify-start text-left"
            disabled={requeue.busy}
            aria-busy={requeue.busy}
            onClick={requeue.run}
          >
            <Icon name="refresh" size={13} />
            {t("requeue")}
          </SharedButton>
        )}
      </div>
    </li>
  );
}
interface Older {
  triggers: TriggerRow[];
  cursor: string | null;
}
const overlaps = (some: TriggerRow[], others: TriggerRow[]) =>
  some.some(item => others.some(other => other.id === item.id));
const byTime = (triggers: TriggerRow[]) =>
  [...new Map(triggers.map(item => [item.id, item])).values()].sort((a, b) => a.at.localeCompare(b.at));
const gapBetween = (newest: ThreadPageView, older: Older | undefined): boolean =>
  !!older && newest.earlier !== null && !overlaps(newest.timeline, older.triggers);
function mergeTimeline(newest: ThreadPageView, older: Older | undefined): ThreadPageView {
  if (!older || newest.earlier === null || gapBetween(newest, older)) return newest;
  return { ...newest, timeline: byTime([...older.triggers, ...newest.timeline]), earlier: older.cursor };
}
const PAGE = 50;
/**
 * Manage a Thread's timeline across live polling, deep-linked `target` Triggers, and manual pagination.
 * Fills any gap between the latest polled page and older loaded pages before merging so the timeline remains contiguous.
 */
function useThreadTimeline(key: string, target: string | undefined) {
  const { call, notify } = usePanel();
  const [older, setOlder] = useState<Older>();
  const {
    data: newest,
    error,
    reload,
  } = usePoll(() => call("GET threads/:key", { key, query: { limit: PAGE } }), [key]);
  const data = newest && mergeTimeline(newest, older);
  const read = (id: string) =>
    !!newest?.timeline.some(item => item.id === id) || !!older?.triggers.some(item => item.id === id);
  const missing = !!target && !!newest && !read(target);
  useEffect(() => {
    if (!missing) return;
    let active = true;
    call("GET threads/:key", { key, query: { limit: PAGE, around: target } }).then(
      page => {
        if (active) setOlder({ triggers: page.timeline, cursor: page.earlier });
      },
      (failure: unknown) => {
        if (active) notify(errorText(failure));
      },
    );
    return () => {
      active = false;
    };
  }, [missing, call, key, target, notify]);
  const gap = !!newest && gapBetween(newest, older);
  useEffect(() => {
    if (!gap || !newest || !older) return;
    let active = true;
    const fill = async () => {
      let run = newest.timeline,
        cursor = newest.earlier;
      while (cursor !== null && !overlaps(run, older.triggers)) {
        const page = await call("GET threads/:key", { key, query: { limit: PAGE, before: cursor } });
        run = [...page.timeline, ...run];
        cursor = page.earlier;
      }
      if (active)
        setOlder({
          triggers: byTime([...older.triggers, ...run]),
          cursor: overlaps(run, older.triggers) ? older.cursor : cursor,
        });
    };
    fill().catch((failure: unknown) => {
      if (active) notify(errorText(failure));
    });
    return () => {
      active = false;
    };
  }, [gap, newest, older, call, key, notify]);
  const earlier = useAction(async (shown: ThreadPageView) => {
    const page = await call("GET threads/:key", { key, query: { limit: PAGE, before: shown.earlier! } });
    setOlder({ triggers: [...page.timeline, ...shown.timeline], cursor: page.earlier });
  });
  return { data, error, reload, earlier };
}
export function ThreadPage({ id, target }: { id: string; target?: string | undefined }) {
  const { t, call, navigate, notify } = usePanel();
  const [decisionsOpen, setDecisionsOpen] = useState(false);
  const { data, error, reload, earlier } = useThreadTimeline(id, target);
  const requeue = useAction(
    async (trigger: string) => {
      const result = await call("POST triggers/:id/requeue", { id: trigger });
      if (!result.queued) notify(t("requeueAlready"));
    },
    { reload },
  );
  if (!data)
    return (
      <>
        <PageHead title={t("term.thread")} />
        {error instanceof ApiError && error.missing ? (
          <Empty>{t("threadNotFound")}</Empty>
        ) : (
          <LoadState error={error} loading />
        )}
      </>
    );
  const subscribed = new Set(data.tickets.map(ticket => ticket.id));
  // Never fold a deep-linked `target` Trigger into an automated run.
  const sender = (trigger: TriggerRow) =>
    !trigger.human && trigger.id !== target ? `${trigger.actor.source}:${trigger.actor.id}` : undefined;
  const unsubscribe = async () => {
    const result = await call("POST threads/:key/unsubscribe", { key: data.key });
    if (result.context_delivery === "pending") notify(t("unsubscribePending"));
    await reload();
  };
  return (
    <>
      <PageHead title={readableMarkers(t, data.title)}>
        {data.url && <ActionLink href={data.url}>{t("openOriginal")}</ActionLink>}
      </PageHead>
      {error && <LoadState error={error} loading={false} />}
      <div className="settings-row-description dt-row-meta dt-status-line">
        <span>{valueLabel(t, "source", data.source)}</span>
        <span>{t("threadLatest", { time: when(data.lastAt, t("lang")) })}</span>
        <span>{t("threadCreated", { time: when(data.createdAt, t("lang")) })}</span>
      </div>
      {data.evaluating && (
        <p className="dt-banner">
          {t("evaluatingBanner", {
            count: data.evaluating.triggers,
            strength: valueLabel(t, "strength", data.evaluating.strength),
            deadline: when(data.evaluating.deadline, t("lang")),
          })}
        </p>
      )}
      {data.pollError && <p className="dt-error dt-clamp">{t("pollFailed", { error: data.pollError })}</p>}
      {data.tickets.length > 0 && (
        <Section title={t("subscribedTickets")} count={data.tickets.length}>
          <ul className="dt-list">
            {data.tickets.map(ticket => (
              <TicketLine key={ticket.id} ticket={ticket} context={data.context.includes(ticket.id)} />
            ))}
          </ul>
        </Section>
      )}
      {data.decisions.length > 0 && (
        <DisclosureRow
          icon={<Icon name="decision" />}
          title={t("threadDecisions", { count: data.decisions.length })}
          open={decisionsOpen}
          onToggle={() => setDecisionsOpen(!decisionsOpen)}
        >
          <div className="dt-disclosure-body">
            <ul className="dt-list">
              {data.decisions.map(decision => (
                <DecisionLine key={decision.id} decision={decision} />
              ))}
            </ul>
          </div>
        </DisclosureRow>
      )}
      {data.correlated.length > 0 && (
        <Section title={t("term.correlation")}>
          <ul className="dt-plain-list">
            {data.correlated.map(item => (
              <li key={item.key}>
                <SharedButton
                  variant="link"
                  size="content"
                  type="button"
                  className="dt-textlink p-0 justify-start text-left"
                  onClick={() => navigate({ page: "trigger", id: item.key })}
                >
                  {readableMarkers(t, item.title)}
                </SharedButton>
              </li>
            ))}
          </ul>
        </Section>
      )}
      <Section title={t("timeline")} count={t("newestFirst")}>
        {data.timeline.length ? (
          <ol className="dt-timeline">
            {automatedRuns(data.timeline.slice().reverse(), sender).map(({ item, earlier: folded }) => (
              <TriggerItem
                key={item.id}
                trigger={item}
                earlier={folded}
                target={target}
                subscribed={subscribed}
                requeue={
                  item.actions.requeue
                    ? {
                        busy: requeue.busy,
                        run: () => {
                          void requeue.run(item.id);
                        },
                      }
                    : undefined
                }
              />
            ))}
          </ol>
        ) : (
          <Hint>{t("noTriggers")}</Hint>
        )}
        {data.earlier && (
          <div>
            <Button
              variant="outline"
              size="sm"
              icon={<Icon name="chevron-down" size={14} />}
              disabled={earlier.busy}
              onClick={() => {
                void earlier.run(data);
              }}
            >
              {t("loadEarlier")}
            </Button>
          </div>
        )}
      </Section>
      {data.tickets.length > 0 && (
        <div className="dt-danger-zone">
          <span className="dt-hint">{t("unsubscribeHint")}</span>
          <ConfirmButton
            variant="outline"
            icon="unsubscribe"
            label={t("unsubscribe")}
            title={t("unsubscribeTitle")}
            message={t("unsubscribeConfirm", { title: data.title })}
            onConfirm={unsubscribe}
          />
        </div>
      )}
    </>
  );
}
