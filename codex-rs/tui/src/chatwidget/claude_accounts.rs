//! The model picker switches the bridge's shared Claude account for subsequent turns.

use super::*;
use codex_app_server_protocol::ClaudeAccountsReadResponse;

const CLAUDE_ACCOUNTS_VIEW_ID: &str = "claude-accounts";

impl ChatWidget {
    pub(super) fn fetch_claude_accounts(&mut self) {
        let request_id = uuid::Uuid::new_v4();
        self.claude_accounts_request_id = Some(request_id);
        self.app_event_tx
            .send(AppEvent::FetchClaudeAccounts { request_id });
    }

    pub(crate) fn on_claude_accounts_loaded(
        &mut self,
        request_id: uuid::Uuid,
        result: Result<ClaudeAccountsReadResponse, String>,
    ) {
        if self.claude_accounts_request_id != Some(request_id) {
            return;
        }
        self.claude_accounts_request_id = None;
        // Discovery is optional for standalone engines and older bridges.
        self.claude_accounts = result.ok();
        self.refresh_elpis_provider_popup();
        self.refresh_open_model_picker();
        if self.bottom_pane.has_view(CLAUDE_ACCOUNTS_VIEW_ID) {
            if self
                .claude_accounts
                .as_ref()
                .is_some_and(|snapshot| !snapshot.accounts.is_empty())
            {
                self.open_claude_accounts_popup();
            } else {
                self.bottom_pane.dismiss_view_by_id(CLAUDE_ACCOUNTS_VIEW_ID);
            }
        }
    }

    /// The "Claude accounts…" row for a list about `provider_id`: only the Claude subscription
    /// has these accounts, so any other provider's list goes without it.
    pub(super) fn claude_accounts_picker_row(&self, provider_id: &str) -> Option<SelectionItem> {
        if provider_id != CLAUDE_SUBSCRIPTION_PROVIDER_ID {
            return None;
        }
        let snapshot = self.claude_accounts.as_ref()?;
        if snapshot.accounts.is_empty() {
            return None;
        }
        let current = snapshot
            .accounts
            .iter()
            .find(|a| a.id == snapshot.active_id);
        Some(SelectionItem {
            name: "Claude accounts…".to_string(),
            description: current.map(|account| {
                format!(
                    "Current: {}",
                    account.email.as_ref().unwrap_or(&account.label)
                )
            }),
            search_value: Some("Claude accounts Anthropic subscription".to_string()),
            actions: vec![Box::new(|tx| tx.send(AppEvent::OpenClaudeAccounts))],
            dismiss_on_select: true,
            ..Default::default()
        })
    }

    pub(crate) fn open_claude_accounts_popup(&mut self) {
        let Some(snapshot) = self
            .claude_accounts
            .as_ref()
            .filter(|s| !s.accounts.is_empty())
        else {
            return;
        };
        let items: Vec<SelectionItem> = snapshot
            .accounts
            .iter()
            .map(|account| {
                let id = account.id.clone();
                let disabled_reason = if account.signing_in {
                    Some("Sign-in is still in progress".to_string())
                } else if account.duplicate {
                    Some("This login shares the same Claude account and limit".to_string())
                } else if !account.authenticated {
                    Some("Sign in under Settings → Models & accounts".to_string())
                } else {
                    account.error.clone()
                };
                SelectionItem {
                    name: account.label.clone(),
                    description: Some(
                        [account.email.as_deref(), account.plan.as_deref()]
                            .into_iter()
                            .flatten()
                            .collect::<Vec<_>>()
                            .join(" · "),
                    ),
                    search_value: Some(format!(
                        "{} {}",
                        account.label,
                        account.email.as_deref().unwrap_or_default()
                    )),
                    is_current: account.id == snapshot.active_id,
                    disabled_reason,
                    actions: vec![Box::new(move |tx| {
                        tx.send(AppEvent::SelectClaudeAccount { id: id.clone() })
                    })],
                    dismiss_on_select: true,
                    ..Default::default()
                }
            })
            .collect();
        let selected_index = self
            .bottom_pane
            .selected_index_for_present_view(CLAUDE_ACCOUNTS_VIEW_ID);
        let initial_selected_idx =
            selected_index.or_else(|| items.iter().position(|item| item.is_current));
        let params = SelectionViewParams {
            view_id: Some(CLAUDE_ACCOUNTS_VIEW_ID),
            title: Some("Claude accounts".to_string()),
            subtitle: Some("Choose the account for the next Claude turn".to_string()),
            items,
            initial_selected_idx,
            is_searchable: true,
            search_placeholder: Some("Search accounts".to_string()),
            ..SelectionViewParams::picker()
        };
        if self.bottom_pane.has_view(CLAUDE_ACCOUNTS_VIEW_ID) {
            self.bottom_pane
                .replace_selection_view_if_present(CLAUDE_ACCOUNTS_VIEW_ID, params);
        } else {
            self.bottom_pane.show_selection_view(params);
        }
    }

    pub(crate) fn on_claude_account_selected(&mut self, snapshot: ClaudeAccountsReadResponse) {
        self.claude_accounts_request_id = None;
        self.model_popup_request_id = None;
        let label = snapshot
            .accounts
            .iter()
            .find(|a| a.id == snapshot.active_id)
            .map(|account| account.email.as_ref().unwrap_or(&account.label).clone())
            .unwrap_or_else(|| snapshot.active_id.clone());
        self.claude_accounts = Some(snapshot);
        self.add_info_message(format!("Claude account: {label}"), None);
    }
}
