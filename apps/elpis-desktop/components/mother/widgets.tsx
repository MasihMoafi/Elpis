import { Button as SharedButton, buttonVariants } from "@/components/ui/button";
import { SettingsEmpty, SettingsGroup, SettingsNotice } from "@/components/settings/rows";
// Adapted from DeepSeek dsh-superagent-prototype (MIT), src/client/widgets.tsx.
/** Context-aware shared UI widgets: page/section headers, timestamps, Markdown rendering, and confirmation actions. */
import { Fragment, useState, type ReactNode } from "react";
import type { SetupProblem } from "../../bridge/router/infra/setup.mts";
import { Button, Icon, InfoTip, Modal, StateDot, type DotState, type IconName } from "./controls.tsx";
import { inlines, linkify, markdownBlocks, type Inline } from "./markdown.ts";
import { useAction, usePanel, usePanelData } from "./provider.tsx";
import { settingsRoute, type SettingsGroup as SettingsGroupRoute } from "./route.ts";
import { errorText, fullTime, readableMarkers, setupText, when } from "./text.ts";

const external = { target: "_blank", rel: "noopener noreferrer" } as const;

export function When({ at }: { at: string | undefined }) {
  const { t } = usePanel();
  return (
    <time dateTime={at} title={fullTime(at, t("lang"))}>
      {when(at, t("lang"))}
    </time>
  );
}
export function SetupMessage({
  problem,
  lead,
}: {
  problem: Pick<SetupProblem, "code" | "values">;
  lead?: boolean | undefined;
}) {
  const { t } = usePanel();
  const text = setupText(t, problem);
  return (
    <>
      {lead ? t("setupProblem", { detail: text }) : text}
      {problem.values.output && <span className="dt-detail dt-mono dt-clamp">{problem.values.output}</span>}
    </>
  );
}
export function Section({
  title,
  count,
  children,
  action,
  hint,
  badge,
  icon,
}: {
  title: string;
  count?: number | string | undefined;
  children: ReactNode;
  action?: ReactNode | undefined;
  hint?: string | undefined;
  badge?: ReactNode | undefined;
  icon?: IconName | undefined;
}) {
  return (
    <SettingsGroup
      title={title}
      action={
        <span className="dt-actions">
          {icon && <Icon name={icon} />}
          {count !== undefined && <span className="dt-count">{count}</span>}
          {hint && <InfoTip text={hint} />}
          {badge}
          {action}
        </span>
      }
    >
      {children}
    </SettingsGroup>
  );
}
export function Hint({ children }: { children: ReactNode }) {
  return <p className="dt-hint">{children}</p>;
}
export function Empty({ children }: { children: string }) {
  return <SettingsEmpty title={children} />;
}
export function LabelValue({ label, value }: { label: string; value: ReactNode }) {
  return (
    <span className="dt-lv">
      <span className="dt-lv-label">{label}</span> <span className="dt-lv-value">{value}</span>
    </span>
  );
}
export function KeyValues({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <dl className="dt-kv">
      {rows.map(([key, value], index) => (
        <div key={index} style={{ display: "contents" }}>
          <dt>{key}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function Inlines({ parts }: { parts: Inline[] }) {
  return (
    <>
      {parts.map((part, index) =>
        part.kind === "bold" ? (
          <strong key={index}>{part.text}</strong>
        ) : part.kind === "code" ? (
          <code key={index} className="dt-code">
            {part.text}
          </code>
        ) : part.kind === "link" ? (
          <a key={index} className="dt-inline-link" href={part.url} title={part.url} {...external}>
            {part.text}
          </a>
        ) : (
          <Fragment key={index}>{part.text}</Fragment>
        ),
      )}
    </>
  );
}
/** Renders a safe Markdown subset (headings, lists, paragraphs, bold, inline code, links) without interpreting raw HTML. */
export function MarkdownLite({ text }: { text: string }) {
  const { t } = usePanel();
  return (
    <div className="dt-md">
      {markdownBlocks(readableMarkers(t, text)).map((block, index) => {
        if (block.kind !== "list")
          return (
            <p key={index} className={block.kind === "heading" ? "dt-md-heading" : undefined}>
              <Inlines parts={inlines(block.text)} />
            </p>
          );
        const items = block.items.map((item, at) => (
          <li key={at}>
            <Inlines parts={inlines(item)} />
          </li>
        ));
        return block.ordered ? <ol key={index}>{items}</ol> : <ul key={index}>{items}</ul>;
      })}
    </div>
  );
}
function MoreToggle({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  const { t } = usePanel();
  return (
    <SharedButton
      variant="link"
      size="content"
      type="button"
      className="dt-textlink dt-more p-0 justify-start text-left"
      aria-expanded={open}
      onClick={onToggle}
    >
      {open ? t("collapse") : t("expand")}
    </SharedButton>
  );
}
export function ClampText({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const long = text.length > 480 || text.split("\n").length > 8;
  return (
    <>
      <div className={long && !open ? "dt-event-text dt-clamp-8" : "dt-event-text"}>
        <Inlines parts={linkify(text)} />
      </div>
      {long && <MoreToggle open={open} onToggle={() => setOpen(!open)} />}
    </>
  );
}

export function ConfirmButton({
  label,
  title,
  message,
  onConfirm,
  variant = "ghost",
  icon,
}: {
  label: string;
  title: string;
  message: string;
  onConfirm: () => Promise<unknown>;
  variant?: "ghost" | "outline" | undefined;
  icon?: IconName | undefined;
}) {
  const { t } = usePanel();
  const [open, setOpen] = useState(false);
  const confirm = useAction(onConfirm);
  return (
    <>
      <Button variant={variant} size="sm" icon={icon && <Icon name={icon} size={14} />} onClick={() => setOpen(true)}>
        {label}
      </Button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={title}
        closeLabel={t("close")}
        description={message}
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              {t("cancel")}
            </Button>
            <Button
              variant="primary"
              disabled={confirm.busy}
              onClick={() => {
                void confirm.run().then(done => {
                  if (done) setOpen(false);
                });
              }}
            >
              {t("confirm")}
            </Button>
          </>
        }
      />
    </>
  );
}
export function SessionButton({
  sessionId,
  label,
  variant = "ghost",
}: {
  sessionId: string;
  label?: string | undefined;
  variant?: "ghost" | "outline" | undefined;
}) {
  const { t, openSession, notify } = usePanel();
  return (
    <Button
      variant={variant}
      size="sm"
      icon={<Icon name="session" size={14} />}
      onClick={() => {
        openSession(sessionId).catch(error => notify(errorText(error)));
      }}
    >
      {label ?? t("openSession")}
    </Button>
  );
}
export function ExternalLink({
  href,
  children,
  icon = "external",
}: {
  href: string;
  children: ReactNode;
  icon?: IconName | undefined;
}) {
  return (
    <a className="dt-inline-link dt-icon-link" href={href} {...external}>
      <Icon name={icon} size={13} />
      {children}
    </a>
  );
}
export function ActionLink({
  href,
  children,
  icon = "external",
}: {
  href: string;
  children: ReactNode;
  icon?: IconName | undefined;
}) {
  return (
    <a className={buttonVariants({ variant: "outline", size: "sm" })} href={href} {...external}>
      <Icon name={icon} />
      {children}
    </a>
  );
}
export function StageMark({ state, icon, label }: { state: DotState; icon: IconName; label: string }) {
  return (
    <span className="dt-stage" data-state={state}>
      {state === "ongoing" ? <StateDot state="ongoing" /> : <Icon name={icon} size={14} />}
      {label}
    </span>
  );
}
export function LoadState({ error, loading }: { error?: Error | undefined; loading: boolean }) {
  const { t } = usePanel();
  if (error) return <SettingsNotice tone="alert">{error.message}</SettingsNotice>;
  return loading ? <SettingsNotice>{t("loading")}</SettingsNotice> : null;
}
export function LoadMore({ onMore }: { onMore: () => void }) {
  const { t } = usePanel();
  return (
    <Button variant="outline" size="sm" icon={<Icon name="chevron-down" size={14} />} onClick={onMore}>
      {t("loadMore")}
    </Button>
  );
}

export function StatusHead({ hint, settings }: { hint: string; settings?: SettingsGroupRoute | undefined }) {
  const { t, navigate } = usePanel();
  return (
    <div className="settings-group-heading">
      <h2>{t("statusTitle")}</h2>
      <InfoTip text={hint} />
      {settings && (
        <Button
          variant="ghost"
          size="sm"
          icon={<Icon name="settings" />}
          onClick={() => navigate(settingsRoute(settings))}
        >
          {t("tab.settings")}
        </Button>
      )}
    </div>
  );
}
export function PageHead({ title, children }: { title: ReactNode; children?: ReactNode | undefined }) {
  const { back, backLabel } = usePanel();
  return (
    <div className="dt-page-head">
      <Button variant="ghost" size="sm" icon={<Icon name="chevron-left" />} onClick={back}>
        {backLabel}
      </Button>
      <div className="dt-page-title">
        <h2>{title}</h2>
        {children && <span className="dt-actions">{children}</span>}
      </div>
    </div>
  );
}
/** Trigger a host setup re-check and restart, prompting for confirmation when running Assignments would be interrupted. */
export function CheckSetupButton() {
  const { t, call, notify, restart } = usePanel();
  const { running } = usePanelData();
  const check = async () => {
    await call("POST setup/check");
    notify(t("setupChecking"));
    restart();
  };
  const action = useAction(check);
  if (running > 0) {
    const message = t("setupCheckInterrupts", { count: running });
    return (
      <ConfirmButton
        variant="outline"
        icon="refresh"
        label={t("setupCheck")}
        title={t("setupCheck")}
        message={message}
        onConfirm={check}
      />
    );
  }
  const icon = <Icon name="refresh" size={14} />;
  return (
    <Button
      variant="outline"
      size="sm"
      icon={icon}
      disabled={action.busy}
      onClick={() => {
        void action.run();
      }}
    >
      {t("setupCheck")}
    </Button>
  );
}
