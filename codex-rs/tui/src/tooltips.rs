use crate::keymap::RuntimeKeymap;
use crate::keymap::keymap_action_id;
use crate::terminal_hyperlinks::HyperlinkLine;
use codex_config::types::TuiKeymap;
use codex_features::FEATURES;
use codex_features::Feature;
use codex_features::FeatureSpec;
use codex_protocol::account::PlanType;
use lazy_static::lazy_static;
use rand::Rng;
use rand::seq::IteratorRandom;
use std::path::Path;

const ANNOUNCEMENT_TIP_URL: &str =
    "https://raw.githubusercontent.com/openai/codex/main/announcement_tip.toml";

const IS_MACOS: bool = cfg!(target_os = "macos");
const IS_WINDOWS: bool = cfg!(target_os = "windows");

const WINDOWS_APP_TOOLTIP: &str = "Use the **desktop app**. Install it from https://chatgpt.com/codex?app-landing-page=true and run `elpis app`.";
const MACOS_APP_TOOLTIP: &str =
    "Use the **desktop app**. Run `elpis app` to open it. It installs automatically if needed.";
const LINUX_APP_TOOLTIP: &str = "Use the **desktop app**. Install it from https://learn.chatgpt.com/docs/linux/linux-app and run `chatgpt`.";

const RAW_TOOLTIPS: &str = include_str!("../assets/tooltips.txt");

lazy_static! {
    static ref TOOLTIPS: Vec<&'static str> = RAW_TOOLTIPS
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with('#'))
        .chain(app_tooltip())
        .collect();
    static ref ALL_TOOLTIPS: Vec<&'static str> = {
        let mut tips = Vec::new();
        tips.extend(TOOLTIPS.iter().copied());
        tips.extend(experimental_tooltips(
            FEATURES,
            codex_realtime_webrtc::RealtimeWebrtcSession::is_supported,
        ));
        tips
    };
}

fn experimental_tooltips(
    features: &[FeatureSpec],
    voice_supported: impl Fn() -> bool,
) -> Vec<&'static str> {
    features
        .iter()
        .filter(|spec| spec.id != Feature::RealtimeConversation || voice_supported())
        .filter_map(|spec| spec.stage.experimental_announcement())
        .collect()
}

/// Pick a random tooltip to show to the user when starting Codex.
pub(crate) fn get_tooltip(plan: Option<PlanType>, keymap: &TuiKeymap) -> Option<String> {
    let mut rng = rand::rng();
    preferred_tooltip(&mut rng, plan).or_else(|| pick_tooltip(&mut rng, keymap))
}

/// Apply the shared announcement and promotion policy before falling back to local tips.
/// The announcement lookup only reads the prewarmed cache.
pub(crate) fn preferred_tooltip<R: Rng + ?Sized>(
    rng: &mut R,
    plan: Option<PlanType>,
) -> Option<String> {
    if let Some(announcement) = announcement::fetch_announcement_tip(plan) {
        return Some(announcement);
    }

    // Leave small chance for a random tooltip to be shown.
    if rng.random_ratio(/*numerator*/ 8, /*denominator*/ 10) {
        return app_tooltip().map(str::to_string);
    }

    None
}

struct LinuxDesktopSession {
    has_display: bool,
    is_wsl: bool,
}

impl LinuxDesktopSession {
    fn current() -> Self {
        #[cfg(target_os = "linux")]
        {
            Self {
                has_display: std::env::var_os("DISPLAY").is_some_and(|value| !value.is_empty())
                    || std::env::var_os("WAYLAND_DISPLAY").is_some_and(|value| !value.is_empty()),
                is_wsl: crate::clipboard_paste::is_probably_wsl(),
            }
        }

        #[cfg(not(target_os = "linux"))]
        {
            Self {
                has_display: false,
                is_wsl: false,
            }
        }
    }
}

fn linux_app_tooltip(session: LinuxDesktopSession) -> Option<&'static str> {
    (session.has_display && !session.is_wsl).then_some(LINUX_APP_TOOLTIP)
}

fn app_tooltip() -> Option<&'static str> {
    if IS_MACOS {
        Some(MACOS_APP_TOOLTIP)
    } else if IS_WINDOWS {
        Some(WINDOWS_APP_TOOLTIP)
    } else {
        linux_app_tooltip(LinuxDesktopSession::current())
    }
}

fn pick_tooltip<R: Rng + ?Sized>(rng: &mut R, keymap: &TuiKeymap) -> Option<String> {
    // Resolve current settings for each new tip; never replace an invalid or unbound keymap
    // with defaults, or cache shortcut text across /keymap edits.
    let keymap = RuntimeKeymap::from_config(keymap).ok();
    resolved_tooltips(keymap.as_ref()).choose(rng)
}

/// Render shared tip styling and links, retaining visible URLs when the terminal needs them.
pub(crate) fn render_tooltip_lines(tip: &str, width: usize, cwd: &Path) -> Vec<HyperlinkLine> {
    crate::markdown_render::render_streaming_markdown_lines_with_width_and_cwd(
        &format!("**Tip:** {tip}"),
        Some(width),
        Some(cwd),
        &crate::markdown_render::hide_web_link_destination,
        crate::markdown_render::ListSpacing::AfterMultiline,
    )
    .lines
}

/// Resolve the local tip pool in catalog order using the supplied runtime keymap.
/// Tips with invalid or unbound shortcuts are omitted; without a keymap, only key-free tips remain.
pub(crate) fn resolved_tooltips(
    keymap: Option<&RuntimeKeymap>,
) -> impl Iterator<Item = String> + '_ {
    ALL_TOOLTIPS
        .iter()
        .filter_map(move |tip| render_tooltip(tip, keymap))
}

pub(crate) fn tooltip_templates() -> impl Iterator<Item = &'static str> {
    ALL_TOOLTIPS.iter().copied()
}

/// Substitute `{key:context.action}` with the current primary shortcut in a Markdown code span.
/// Skip the tip if a placeholder is invalid or its action has no binding.
pub(crate) fn render_tooltip(mut template: &str, keymap: Option<&RuntimeKeymap>) -> Option<String> {
    let mut rendered = String::new();
    while let Some((prefix, rest)) = template.split_once("{key:") {
        let (action, suffix) = rest.split_once('}')?;
        let (context, action) = action.split_once('.')?;
        let action = keymap_action_id(context, action)?;
        let hint = keymap?.primary_hint(action.context, action.action)?;
        rendered.push_str(prefix);
        // A key or two-key chord can contain literal backticks; use a padded code span.
        rendered.push_str(&format!("`` {} ``", hint.display_label()));
        template = suffix;
    }
    rendered.push_str(template);
    Some(rendered)
}

pub(crate) mod announcement {
    use crate::tooltips::ANNOUNCEMENT_TIP_URL;
    use crate::version::CODEX_CLI_VERSION;
    use chrono::NaiveDate;
    use chrono::Utc;
    use codex_http_client::ClientRouteClass;
    use codex_http_client::HttpClientFactory;
    use codex_http_client::RouteAwareClientPool;
    use codex_protocol::account::PlanType;
    use regex_lite::Regex;
    use serde::Deserialize;
    use std::sync::OnceLock;
    use std::time::Duration;

    static ANNOUNCEMENT_TIP: OnceLock<Option<AnnouncementTips>> = OnceLock::new();
    const CURRENT_OS: TargetOs = TargetOs::current();

    /// Prewarm the cache of the announcement tip.
    pub(crate) fn prewarm(http_client_factory: HttpClientFactory) {
        if ANNOUNCEMENT_TIP.get().is_some() {
            return;
        }
        tokio::spawn(async move {
            let announcement_tip = fetch_announcement_tip_text(http_client_factory)
                .await
                .and_then(|raw| AnnouncementTips::parse(&raw));
            let _ = ANNOUNCEMENT_TIP.set(announcement_tip);
        });
    }

    /// Fetch the announcement tip, return None if the prewarm is not done yet.
    pub(crate) fn fetch_announcement_tip(plan: Option<PlanType>) -> Option<String> {
        ANNOUNCEMENT_TIP
            .get()
            .and_then(Option::as_ref)
            .and_then(|tips| tips.select(plan))
    }

    #[derive(Debug, Deserialize)]
    struct AnnouncementTipRaw {
        content: String,
        from_date: Option<String>,
        to_date: Option<String>,
        version_regex: Option<String>,
        target_app: Option<String>,
        target_plan_types: Option<Vec<PlanType>>,
        target_oses: Option<Vec<TargetOs>>,
    }

    #[derive(Debug, Deserialize)]
    struct AnnouncementTipDocument {
        announcements: Vec<AnnouncementTipRaw>,
    }

    #[derive(Debug)]
    struct AnnouncementTip {
        content: String,
        from_date: Option<NaiveDate>,
        to_date: Option<NaiveDate>,
        version_regex: Option<Regex>,
        target_app: String,
        target_plan_types: Option<Vec<PlanType>>,
        target_oses: Option<Vec<TargetOs>>,
    }

    #[derive(Debug, Deserialize, Copy, Clone, PartialEq, Eq)]
    #[serde(rename_all = "lowercase")]
    enum TargetOs {
        Linux,
        Macos,
        Windows,
        #[serde(other)]
        Unknown,
    }

    impl TargetOs {
        const fn current() -> Self {
            if cfg!(target_os = "macos") {
                Self::Macos
            } else if cfg!(target_os = "windows") {
                Self::Windows
            } else {
                // Codex currently publishes CLI builds for macOS, Windows, and Linux.
                Self::Linux
            }
        }
    }

    async fn fetch_announcement_tip_text(http_client_factory: HttpClientFactory) -> Option<String> {
        let client = RouteAwareClientPool::new(http_client_factory, ClientRouteClass::Other);
        let response = client
            .get(ANNOUNCEMENT_TIP_URL)
            .timeout(Duration::from_millis(2000))
            .send()
            .await
            .ok()?;
        response.error_for_status().ok()?.text().await.ok()
    }

    /// Parsed once during prewarming; eligibility stays current across redraws and account changes.
    pub(super) struct AnnouncementTips(Vec<AnnouncementTip>);

    impl AnnouncementTips {
        pub(super) fn parse(text: &str) -> Option<Self> {
            let announcements = toml::from_str::<AnnouncementTipDocument>(text)
                .map(|doc| doc.announcements)
                .or_else(|_| toml::from_str::<Vec<AnnouncementTipRaw>>(text))
                .ok()?;
            Some(Self(
                announcements
                    .into_iter()
                    .filter_map(AnnouncementTip::from_raw)
                    .collect(),
            ))
        }

        pub(super) fn select(&self, plan: Option<PlanType>) -> Option<String> {
            let today = Utc::now().date_naive();
            self.0
                .iter()
                .rev()
                .find(|tip| {
                    let plan_matches = tip.target_plan_types.as_ref().is_none_or(|target_plans| {
                        plan.is_some_and(|plan| target_plans.contains(&plan))
                    });
                    let os_matches = tip
                        .target_oses
                        .as_ref()
                        .is_none_or(|target_oses| target_oses.contains(&CURRENT_OS));
                    tip.version_matches(CODEX_CLI_VERSION)
                        && tip.date_matches(today)
                        && tip.target_app == "cli"
                        && plan_matches
                        && os_matches
                })
                .map(|tip| tip.content.clone())
        }
    }

    impl AnnouncementTip {
        fn from_raw(raw: AnnouncementTipRaw) -> Option<Self> {
            let content = raw.content.trim();
            if content.is_empty() {
                return None;
            }

            let from_date = match raw.from_date {
                Some(date) => Some(NaiveDate::parse_from_str(&date, "%Y-%m-%d").ok()?),
                None => None,
            };
            let to_date = match raw.to_date {
                Some(date) => Some(NaiveDate::parse_from_str(&date, "%Y-%m-%d").ok()?),
                None => None,
            };
            let version_regex = match raw.version_regex {
                Some(pattern) => Some(Regex::new(&pattern).ok()?),
                None => None,
            };
            let target_plan_types = raw.target_plan_types;
            if target_plan_types
                .as_ref()
                .is_some_and(|plans| plans.contains(&PlanType::Unknown))
            {
                return None;
            }
            let target_oses = raw.target_oses;
            if target_oses
                .as_ref()
                .is_some_and(|oses| oses.contains(&TargetOs::Unknown))
            {
                return None;
            }

            Some(Self {
                content: content.to_string(),
                from_date,
                to_date,
                version_regex,
                target_app: raw.target_app.unwrap_or("cli".to_string()).to_lowercase(),
                target_plan_types,
                target_oses,
            })
        }

        fn version_matches(&self, version: &str) -> bool {
            self.version_regex
                .as_ref()
                .is_none_or(|regex| regex.is_match(version))
        }

        fn date_matches(&self, today: NaiveDate) -> bool {
            if let Some(from) = self.from_date
                && today < from
            {
                return false;
            }
            if let Some(to) = self.to_date
                && today >= to
            {
                return false;
            }
            true
        }
    }
}
