// Adapted from DeepSeek dsh-superagent-prototype (MIT), src/client/controls.tsx.
// The panel keeps its control contract; Elpis owns their appearance, focus, switches, dialogs and tooltips.
import { useRef, type ButtonHTMLAttributes, type InputHTMLAttributes, type KeyboardEvent, type ReactNode } from "react";
import {
  ArrowLeft,
  ArrowRight,
  ChevronDown,
  ChevronUp,
  Search,
  CircleHelp,
  Plus,
  Trash,
  RefreshCw,
  Clock,
  History,
  Shield,
  CircleCheck,
  MessageSquare,
  Inbox,
  Hash,
  Filter,
  User,
  X,
  Settings,
  ExternalLink,
  Terminal,
  CircleStop,
  Pause,
  Play,
  BellOff,
  EyeOff,
  GitPullRequest,
  Copy,
  ClipboardCheck,
  MessageCircleQuestion,
  AlertTriangle,
  Check,
  LoaderCircle,
  FileText,
  Folder,
  Users,
  List,
  type LucideIcon,
} from "lucide-react";
import { Button as ElpisButton } from "@/components/ui/button";
import { Input as ElpisInput } from "@/components/ui/input";
import { SearchField } from "@/components/ui/search-field";
import { Segmented } from "@/components/settings/rows";
import { Switch as ElpisSwitch } from "@/components/ui/switch";
import { Tooltip } from "@/components/ui/tooltip";
import { DisclosureSummary } from "@/components/ui/disclosure-summary";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogHeader,
  AlertDialogFooter,
} from "@/components/ui/alert-dialog";
import { cn } from "@/lib/utils";
const ICONS = {
  "chevron-left": ArrowLeft,
  "chevron-right": ArrowRight,
  "chevron-down": ChevronDown,
  "chevron-up": ChevronUp,
  search: Search,
  question: CircleHelp,
  plus: Plus,
  trash: Trash,
  refresh: RefreshCw,
  clock: Clock,
  history: History,
  shield: Shield,
  decision: CircleCheck,
  message: MessageSquare,
  inbox: Inbox,
  hash: Hash,
  filter: Filter,
  user: User,
  close: X,
  settings: Settings,
  external: ExternalLink,
  session: Terminal,
  stop: CircleStop,
  pause: Pause,
  play: Play,
  unsubscribe: BellOff,
  dismiss: EyeOff,
  pull: GitPullRequest,
  copy: Copy,
  review: ClipboardCheck,
  ask: MessageCircleQuestion,
  warning: AlertTriangle,
  check: Check,
  spinner: LoaderCircle,
  file: FileText,
  folder: Folder,
  users: Users,
  list: List,
  alert: AlertTriangle,
  blocked: CircleStop,
  queue: List,
  running: LoaderCircle,
} satisfies Record<string, LucideIcon>;
export type IconName = keyof typeof ICONS;
export function Icon({ name, size = 16 }: { name: IconName; size?: number | undefined }) {
  const Glyph = ICONS[name];
  return <Glyph size={size} aria-hidden="true" />;
}
type ButtonProps = {
  variant?: "primary" | "ghost" | "outline" | undefined;
  size?: "md" | "sm" | undefined;
  icon?: ReactNode | undefined;
  className?: string | undefined;
} & ButtonHTMLAttributes<HTMLButtonElement>;
export function Button({
  variant = "ghost",
  size = "md",
  icon,
  className,
  children,
  type = "button",
  ...rest
}: ButtonProps) {
  return (
    <ElpisButton
      type={type}
      variant={variant === "primary" ? "default" : variant}
      size={children ? (size === "sm" ? "sm" : "default") : "icon"}
      className={className}
      {...rest}
    >
      {icon}
      {children}
    </ElpisButton>
  );
}
export type TagTone = "outline" | "neutral" | "quiet" | "success" | "info" | "warning" | "danger";
export function Tag({
  tone = "outline",
  title,
  children,
}: {
  tone?: TagTone | undefined;
  title?: string | undefined;
  children: ReactNode;
}) {
  return (
    <span
      className={cn(
        "settings-badge",
        tone === "warning" && "warn",
        tone === "success" && "ok",
        tone === "danger" && "text-destructive",
        tone === "info" && "text-primary",
      )}
      title={title}
    >
      {children}
    </span>
  );
}
export function Pill({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <ElpisButton variant={active ? "secondary" : "ghost"} size="sm" aria-pressed={active} onClick={onClick}>
      {children}
    </ElpisButton>
  );
}
function walk<V extends string>(event: KeyboardEvent, values: readonly V[], value: V, onChange: (next: V) => void) {
  const index = values.indexOf(value),
    steps: Record<string, number> = { ArrowRight: index + 1, ArrowLeft: index - 1, Home: 0, End: values.length - 1 },
    next = steps[event.key];
  if (next === undefined) return;
  event.preventDefault();
  onChange(values[(next + values.length) % values.length]!);
  const list = event.currentTarget as HTMLElement;
  requestAnimationFrame(() =>
    list.querySelector<HTMLElement>('[role="tab"][aria-selected="true"], [role="radio"][aria-checked="true"]')?.focus(),
  );
}
interface TabItem<V extends string> {
  value: V;
  label: string;
  id: string;
  panelId: string;
}
export function SegmentedTabs<V extends string>({
  items,
  value,
  onChange,
  label,
  className,
}: {
  items: readonly TabItem<V>[];
  value: V;
  onChange: (next: V) => void;
  label: string;
  className?: string | undefined;
}) {
  return (
    <div
      role="tablist"
      aria-label={label}
      className={cn("segmented dt-tabs", className)}
      onKeyDown={event =>
        walk(
          event,
          items.map(item => item.value),
          value,
          onChange,
        )
      }
    >
      {items.map(item => (
        <ElpisButton
          variant={item.value === value ? "secondary" : "ghost"}
          size="sm"
          key={item.value}
          role="tab"
          id={item.id}
          aria-controls={item.panelId}
          aria-selected={item.value === value}
          tabIndex={item.value === value ? 0 : -1}
          onClick={() => onChange(item.value)}
        >
          {item.label}
        </ElpisButton>
      ))}
    </div>
  );
}
export function SegmentedControl<V extends string>({
  options,
  value,
  onChange,
  label,
  disabled,
  className,
}: {
  options: readonly { value: V; label: string; title?: string | undefined }[];
  value: V;
  onChange: (next: V) => void;
  label: string;
  disabled?: boolean | undefined;
  className?: string | undefined;
}) {
  return (
    <div
      className={cn("inline-flex max-w-full", className)}
      onKeyDown={event => {
        if (!disabled)
          walk(
            event,
            options.map(item => item.value),
            value,
            onChange,
          );
      }}
    >
      <Segmented
        label={label}
        value={value}
        options={options.map(({ title, ...option }) => ({ ...option, ...(title === undefined ? {} : { title }) }))}
        onChange={onChange}
        {...(disabled === undefined ? {} : { disabled })}
      />
    </div>
  );
}
export function Input({
  icon,
  className,
  ...rest
}: { icon?: ReactNode | undefined; className?: string | undefined } & InputHTMLAttributes<HTMLInputElement>) {
  return rest.type === "search" ? (
    <SearchField className={className} {...rest} />
  ) : icon ? (
    <span className="flex min-w-0 items-center gap-2">
      {icon}
      <ElpisInput className={className} {...rest} />
    </span>
  ) : (
    <ElpisInput className={className} {...rest} />
  );
}
export function Switch({
  checked,
  onChange,
  label,
  className,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  className?: string | undefined;
}) {
  return <ElpisSwitch checked={checked} aria-label={label} className={className} onCheckedChange={onChange} />;
}
export type DotState = "done" | "warning" | "ongoing" | "error" | "idle";
export function StateDot({ state, className }: { state: DotState; className?: string | undefined }) {
  return state === "ongoing" ? (
    <LoaderCircle size={16} aria-hidden="true" className={cn("animate-spin", className)} />
  ) : (
    <span className={cn("dt-state-dot", className)} data-state={state} aria-hidden="true" />
  );
}
export function Dot({ state, label }: { state: DotState; label?: string | undefined }) {
  return (
    <span className="dt-dot-wrap" title={label} {...(label ? { role: "img", "aria-label": label } : {})}>
      <StateDot state={state} />
    </span>
  );
}
export function DisclosureRow({
  icon,
  title,
  open,
  onToggle,
  collapsedContent,
  children,
}: {
  icon: ReactNode;
  title: ReactNode;
  open: boolean;
  onToggle: () => void;
  collapsedContent?: ReactNode | undefined;
  children?: ReactNode | undefined;
}) {
  return (
    <details className="dt-disclosure" open={open}>
      <DisclosureSummary
        onClick={event => {
          event.preventDefault();
          onToggle();
        }}
      >
        {icon}
        {title}
        {!open && collapsedContent}
      </DisclosureSummary>
      {open && children}
    </details>
  );
}
export function Modal({
  open,
  onClose,
  title,
  closeLabel,
  description,
  footer,
  className,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  closeLabel: string;
  description?: string | undefined;
  footer?: ReactNode | undefined;
  className?: string | undefined;
  children?: ReactNode | undefined;
}) {
  return (
    <AlertDialog
      open={open}
      onOpenChange={next => {
        if (!next) onClose();
      }}
    >
      <AlertDialogContent role="dialog" className={cn("max-h-[85vh] overflow-auto", className)}>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          {description && <AlertDialogDescription>{description}</AlertDialogDescription>}
        </AlertDialogHeader>
        {children}
        <AlertDialogFooter>{footer ?? <Button onClick={onClose}>{closeLabel}</Button>}</AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
export function InfoTip({
  text,
  icon = "question",
  warn,
}: {
  text: string;
  icon?: IconName | undefined;
  warn?: boolean | undefined;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  return (
    <Tooltip content={text}>
      <ElpisButton
        ref={ref}
        variant="ghost"
        size="icon-xs"
        aria-label={text}
        className={warn ? "text-destructive" : undefined}
      >
        <Icon name={icon} />
      </ElpisButton>
    </Tooltip>
  );
}
