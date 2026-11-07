# Panel

Adapted from dsh-superagent `docs/005-panel.md`. The page is [components/mother](../../../apps/elpis-desktop/components/mother), using Elpis controls, typography, colors and page dimensions.

Open Mother in the sidebar or command menu, Open Mother panel in Settings → Configuration, or Mother panel in the Mother chat header. Native router and worker sessions open through the existing chat navigation.

| Page | Content |
| --- | --- |
| Overview | Work needing a person, actionable system problems, the last day's flow and worker load. |
| Source | Installed/enabled kinds, health, filtered input and dropped messages. |
| Trigger | Thread filters, timeline pages, follow-up ownership, decisions and subscriptions. |
| Eval | Decisions, reasons, matched rules, observe-only proposals and unresolved evaluations. |
| Execution | Open/ended Ticket filters, pause, retry, stop, authorization, inputs, assignments and native session links. |
| Settings | Source forms, allowed people/admission, assessment, execution, prompt editing/history and deployment limits. |

Search finds stored Trigger text, ids, URLs, Threads and Tickets. Glossary, drafts, history, preview comparisons and confirmation dialogs preserve the reference panel's behavior. Shared Elpis controls own keyboard behavior, focus, switches, selects, dialogs and tooltips.

The panel calls the authenticated local [Mother HTTP handler](../../../apps/elpis-desktop/bridge/router/app/http.mts) through the existing desktop bridge. It can configure a disabled Mother without starting a native session or polling. Counts and lists come from the same domain views.
