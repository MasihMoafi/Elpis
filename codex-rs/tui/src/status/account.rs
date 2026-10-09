#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum StatusAccountDisplay {
    ChatGpt {
        email: Option<String>,
        plan: Option<String>,
    },
    ApiKey,
    /// A Claude or Antigravity chat: the subscription the bridge reaches, and its sign-in.
    Subscription {
        name: String,
        email: Option<String>,
        plan: Option<String>,
    },
}
