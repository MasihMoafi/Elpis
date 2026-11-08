import type React from "react";
import { X } from "lucide-react";
import { ApprovalCard } from "@/components/approval-card";
import { Button } from "@/components/ui/button";
import { title, type Approval, type Thread } from "@/lib/api";
import type { createApprovalActions } from "@/lib/approval-actions";
import { approvalDraftKey } from "@/lib/use-drafts";

type Common = {
  approvals: Approval[];
  threads: Thread[];
  button: React.RefObject<HTMLButtonElement | null>;
  setOpen: React.Dispatch<React.SetStateAction<boolean>>;
};
type TriggerProps = Common & { open: boolean };
type PanelProps = Common & {
  openById: (id: string) => void;
  approvalCardProps: ReturnType<typeof createApprovalActions>["approvalCardProps"];
};

export function PendingInputTrigger({ approvals, threads, button, setOpen, open }: TriggerProps) {
  const first = approvals[0]!;
  return (
    <div className="pending-input-anchor">
      <Button
        ref={button}
        className="pending-input-trigger"
        variant="secondary"
        size="sm"
        aria-label={`Needs input (${approvals.length})`}
        aria-expanded={open}
        aria-controls="pending-input-panel"
        onKeyDown={event => {
          if (event.key === "Escape") setOpen(false);
        }}
        onClick={() => setOpen(value => !value)}
      >
        <span className="pending-count">{approvals.length}</span>Needs input
        <span className="pending-task-name">
          {title(
            threads.find(thread => thread.id === first.params.threadId) ||
              first.thread || { id: first.params.threadId || "unreported" },
          )}
        </span>
      </Button>
    </div>
  );
}

export function PendingInputPanel({ approvals, threads, button, setOpen, openById, approvalCardProps }: PanelProps) {
  return (
    <section
      id="pending-input-panel"
      aria-label="Pending input"
      className="pending-input-panel"
      onKeyDown={event => {
        if (event.key === "Escape") {
          setOpen(false);
          button.current?.focus();
        }
      }}
    >
      <div className="pending-panel-heading">
        <div>
          <h2>Needs input</h2>
          <p>
            {approvals.length} {approvals.length === 1 ? "request" : "requests"} waiting for you
          </p>
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Close pending input"
          onClick={() => {
            setOpen(false);
            button.current?.focus();
          }}
        >
          <X size={16} />
        </Button>
      </div>
      <div className="pending-request-list">
        {approvals.map(approval => {
          const thread = threads.find(item => item.id === approval.params.threadId);
          const requester = thread ?? approval.thread;
          const name = requester ? title(requester) : approval.params.threadId || "Conversation not reported";
          return (
            <div key={approvalDraftKey(approval)} className="pending-request">
              <div className="pending-request-heading">
                <p>{name}</p>
                {approval.params.threadId && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setOpen(false);
                      openById(approval.params.threadId!);
                    }}
                  >
                    Open chat
                  </Button>
                )}
              </div>
              <ApprovalCard {...approvalCardProps(approval)} globalKeys={false} />
            </div>
          );
        })}
      </div>
    </section>
  );
}
