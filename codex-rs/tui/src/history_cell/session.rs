// Modified from OpenAI Codex (Apache-2.0) by the Elpis project.
//! Session headers, onboarding guidance, and transcript cards.

use super::*;
use crate::branding::CODEX_RUNTIME_TITLE;
use crate::style::brand_style;

pub(crate) const SESSION_HEADER_MAX_INNER_WIDTH: usize = 56; // Just an eyeballed value

/// This release's headline changes, shown in the welcome card so Elpis opens as
/// itself — not as a Codex look-alike. Update alongside each release.
const WHATS_NEW_LINES: [&str; 0] = [];

pub(crate) fn card_inner_width(width: u16, max_inner_width: usize) -> Option<usize> {
    if width < 4 {
        return None;
    }
    let inner_width = std::cmp::min(width.saturating_sub(4) as usize, max_inner_width);
    Some(inner_width)
}

/// Render `lines` inside a border sized to the widest span in the content.
pub(crate) fn with_border(lines: Vec<Line<'static>>) -> Vec<Line<'static>> {
    with_border_internal(lines, /*forced_inner_width*/ None)
}

/// Render `lines` inside a border whose inner width is at least `inner_width`.
///
/// This is useful when callers have already clamped their content to a
/// specific width and want the border math centralized here instead of
/// duplicating padding logic in the TUI widgets themselves.
pub(crate) fn with_border_with_inner_width(
    lines: Vec<Line<'static>>,
    inner_width: usize,
) -> Vec<Line<'static>> {
    with_border_internal(lines, Some(inner_width))
}

fn with_border_internal(
    lines: Vec<Line<'static>>,
    forced_inner_width: Option<usize>,
) -> Vec<Line<'static>> {
    let max_line_width = lines
        .iter()
        .map(|line| {
            line.iter()
                .map(|span| UnicodeWidthStr::width(span.content.as_ref()))
                .sum::<usize>()
        })
        .max()
        .unwrap_or(0);
    let content_width = forced_inner_width
        .unwrap_or(max_line_width)
        .max(max_line_width);

    let mut out = Vec::with_capacity(lines.len() + 2);
    let border_inner_width = content_width + 2;
    out.push(vec![format!("╭{}╮", "─".repeat(border_inner_width)).dim()].into());

    for line in lines.into_iter() {
        let used_width: usize = line
            .iter()
            .map(|span| UnicodeWidthStr::width(span.content.as_ref()))
            .sum();
        let span_count = line.spans.len();
        let mut spans: Vec<Span<'static>> = Vec::with_capacity(span_count + 4);
        spans.push(Span::from("│ ").dim());
        spans.extend(line);
        if used_width < content_width {
            spans.push(Span::from(" ".repeat(content_width - used_width)).dim());
        }
        spans.push(Span::from(" │").dim());
        out.push(Line::from(spans));
    }

    out.push(vec![format!("╰{}╯", "─".repeat(border_inner_width)).dim()].into());

    out
}

/// Return the emoji followed by a hair space (U+200A).
/// Using only the hair space avoids excessive padding after the emoji while
/// still providing a small visual gap across terminals.
pub(crate) fn padded_emoji(emoji: &str) -> String {
    format!("{emoji}\u{200A}")
}

#[derive(Debug)]
pub struct SessionInfoCell(CompositeHistoryCell);

impl HistoryCell for SessionInfoCell {
    fn display_lines(&self, width: u16) -> Vec<Line<'static>> {
        self.0.display_lines(width)
    }

    fn desired_height(&self, width: u16) -> u16 {
        self.0.desired_height(width)
    }

    fn transcript_lines(&self, width: u16) -> Vec<Line<'static>> {
        self.0.transcript_lines(width)
    }

    fn raw_lines(&self) -> Vec<Line<'static>> {
        self.0.raw_lines()
    }
}

pub(crate) fn new_session_info(
    config: &Config,
    requested_model: &str,
    session: &ThreadSessionState,
    is_first_event: bool,
    _tooltip_override: Option<String>,
    _auth_plan: Option<PlanType>,
    show_fast_status: bool,
) -> SessionInfoCell {
    // Header box rendered as history (so it appears at the very top)
    let header = SessionHeaderHistoryCell::new(
        session.model.clone(),
        session.reasoning_effort.clone(),
        show_fast_status,
        config.cwd.to_path_buf(),
        CODEX_CLI_VERSION,
    )
    .with_yolo_mode(has_yolo_permissions(
        session.approval_policy,
        &session.permission_profile,
    ));
    let mut parts: Vec<Box<dyn HistoryCell>> = vec![Box::new(header)];

    if is_first_event {
        // Help lines below the header (new copy and list)
        let help_lines: Vec<Line<'static>> = vec![
            "  To get started, describe a task or try one of these commands:"
                .dim()
                .into(),
            Line::from(""),
            Line::from(vec![
                "  ".into(),
                "/init".into(),
                " - create an AGENTS.md file with instructions for Elpis".dim(),
            ]),
            Line::from(vec![
                "  ".into(),
                "/usage".into(),
                " - show current session configuration".dim(),
            ]),
            Line::from(vec![
                "  ".into(),
                "/permissions".into(),
                " - choose what Elpis is allowed to do".dim(),
            ]),
            Line::from(vec![
                "  ".into(),
                "/model".into(),
                " - choose what model and reasoning effort to use".dim(),
            ]),
            Line::from(vec![
                "  ".into(),
                "/review".into(),
                " - review any changes and find issues".dim(),
            ]),
        ];

        parts.push(Box::new(PlainHistoryCell { lines: help_lines }));
    } else {
        if requested_model != session.model.as_str() {
            let lines = vec![
                "model changed:".magenta().bold().into(),
                format!("requested: {requested_model}").into(),
                format!("used: {}", session.model).into(),
            ];
            parts.push(Box::new(PlainHistoryCell { lines }));
        }
    }

    SessionInfoCell(CompositeHistoryCell { parts })
}

pub(crate) fn is_yolo_mode(config: &Config) -> bool {
    has_yolo_permissions(
        AskForApproval::from(config.permissions.approval_policy.value()),
        &config.permissions.effective_permission_profile(),
    )
}

pub(crate) fn has_yolo_permissions(
    approval_policy: AskForApproval,
    permission_profile: &PermissionProfile,
) -> bool {
    approval_policy == AskForApproval::Never
        && matches!(
            permission_profile,
            PermissionProfile::Disabled
                | PermissionProfile::Managed {
                    file_system: ManagedFileSystemPermissions::Unrestricted,
                    network: NetworkSandboxPolicy::Enabled,
                }
        )
}
#[derive(Debug)]
pub(crate) struct SessionHeaderHistoryCell {
    version: &'static str,
    model: String,
    model_style: Style,
    reasoning_effort: Option<ReasoningEffortConfig>,
    show_fast_status: bool,
    directory: PathBuf,
    yolo_mode: bool,
}

impl SessionHeaderHistoryCell {
    pub(crate) fn new(
        model: String,
        reasoning_effort: Option<ReasoningEffortConfig>,
        show_fast_status: bool,
        directory: PathBuf,
        version: &'static str,
    ) -> Self {
        Self::new_with_style(
            model,
            Style::default(),
            reasoning_effort,
            show_fast_status,
            directory,
            version,
        )
    }

    pub(crate) fn new_with_style(
        model: String,
        model_style: Style,
        reasoning_effort: Option<ReasoningEffortConfig>,
        show_fast_status: bool,
        directory: PathBuf,
        version: &'static str,
    ) -> Self {
        Self {
            version,
            model,
            model_style,
            reasoning_effort,
            show_fast_status,
            directory,
            yolo_mode: false,
        }
    }

    pub(crate) fn with_yolo_mode(mut self, yolo_mode: bool) -> Self {
        self.yolo_mode = yolo_mode;
        self
    }

    fn format_directory(&self, max_width: Option<usize>) -> String {
        Self::format_directory_inner(&self.directory, max_width)
    }

    pub(crate) fn format_directory_inner(directory: &Path, max_width: Option<usize>) -> String {
        let formatted = if let Some(rel) = relativize_to_home(directory) {
            if rel.as_os_str().is_empty() {
                "~".to_string()
            } else {
                format!("~{}{}", std::path::MAIN_SEPARATOR, rel.display())
            }
        } else {
            directory.display().to_string()
        };

        if let Some(max_width) = max_width {
            if max_width == 0 {
                return String::new();
            }
            if UnicodeWidthStr::width(formatted.as_str()) > max_width {
                return crate::text_formatting::center_truncate_path(&formatted, max_width);
            }
        }

        formatted
    }

    fn reasoning_label(&self) -> Option<&str> {
        self.reasoning_effort
            .as_ref()
            .map(ReasoningEffortConfig::as_str)
    }
}

impl HistoryCell for SessionHeaderHistoryCell {
    fn display_lines(&self, width: u16) -> Vec<Line<'static>> {
        let Some(inner_width) = card_inner_width(width, SESSION_HEADER_MAX_INNER_WIDTH) else {
            return Vec::new();
        };

        let make_row = |spans: Vec<Span<'static>>| Line::from(spans);

        // Title line rendered inside the box: ">_ Elpis · Codex runtime (vX)"
        let mut title_spans: Vec<Span<'static>> = vec![
            Span::from(">_ ").dim(),
            Span::from(CODEX_RUNTIME_TITLE).style(brand_style()),
            Span::from(" ").dim(),
            Span::from(format!("(v{})", self.version)).dim(),
        ];
        // An unoptimized build must never be mistaken for a release one, either by a
        // user reporting slow startup or by us when shipping.
        if crate::startup_timing::is_debug_build() {
            title_spans.push(Span::from("  "));
            title_spans.push(Span::from(" DEBUG BUILD ").black().on_red().bold());
        }

        const CHANGE_MODEL_HINT_COMMAND: &str = "/model";
        const CHANGE_MODEL_HINT_EXPLANATION: &str = " to change";
        const DIR_LABEL: &str = "directory:";
        const PERMISSIONS_LABEL: &str = "permissions:";
        let label_width = if self.yolo_mode {
            DIR_LABEL.len().max(PERMISSIONS_LABEL.len())
        } else {
            DIR_LABEL.len()
        };

        let model_label = format!(
            "{model_label:<label_width$}",
            model_label = "model:",
            label_width = label_width
        );
        let reasoning_label = self.reasoning_label();
        let model_spans: Vec<Span<'static>> = {
            let mut spans = vec![
                Span::from(format!("{model_label} ")).dim(),
                Span::styled(self.model.clone(), self.model_style),
            ];
            if let Some(reasoning) = reasoning_label {
                spans.push(Span::from(" "));
                spans.push(Span::from(reasoning.to_owned()));
            }
            if self.show_fast_status {
                spans.push("   ".into());
                spans.push(Span::styled("fast", self.model_style.magenta()));
            }
            spans.push("   ".dim());
            spans.push(CHANGE_MODEL_HINT_COMMAND.cyan());
            spans.push(CHANGE_MODEL_HINT_EXPLANATION.dim());
            spans
        };

        let dir_label = format!("{DIR_LABEL:<label_width$}");
        let dir_prefix = format!("{dir_label} ");
        let dir_prefix_width = UnicodeWidthStr::width(dir_prefix.as_str());
        let dir_max_width = inner_width.saturating_sub(dir_prefix_width);
        let dir = self.format_directory(Some(dir_max_width));
        let dir_spans = vec![Span::from(dir_prefix).dim(), Span::from(dir)];

        let whats_new_rows: Vec<Line<'static>> = WHATS_NEW_LINES
            .iter()
            .enumerate()
            .map(|(index, entry)| {
                let label = if index == 0 {
                    "what's new: "
                } else {
                    "            "
                };
                make_row(vec![Span::from(label).dim(), Span::from(*entry).cyan()])
            })
            .collect();

        let mut lines = vec![make_row(title_spans)];
        lines.extend(whats_new_rows);
        lines.extend([
            make_row(Vec::new()),
            make_row(model_spans),
            make_row(dir_spans),
        ]);

        if self.yolo_mode {
            let permissions_label = format!("{PERMISSIONS_LABEL:<label_width$}");
            lines.push(make_row(vec![
                Span::from(format!("{permissions_label} ")).dim(),
                "YOLO mode".magenta().bold(),
            ]));
        }

        // Absent until a real launch publishes it, so this stays out of snapshot tests.
        if let Some(startup) = crate::startup_timing::total_display() {
            let startup_label = format!("{:<label_width$}", "startup:");
            lines.push(make_row(vec![
                Span::from(format!("{startup_label} ")).dim(),
                Span::from(startup).dim(),
                Span::from("   ").dim(),
                Span::from(crate::startup_timing::build_profile()).dim(),
            ]));
        }

        with_border(lines)
    }

    fn raw_lines(&self) -> Vec<Line<'static>> {
        let mut lines = vec![
            Line::from(format!("{CODEX_RUNTIME_TITLE} (v{})", self.version)),
            Line::from(format!("what's new: {}", WHATS_NEW_LINES.join(" · "))),
            Line::from(format!(
                "model: {}{}",
                self.model,
                self.reasoning_label()
                    .map(|reasoning| format!(" {reasoning}"))
                    .unwrap_or_default()
            )),
            Line::from(format!(
                "directory: {}",
                self.format_directory(/*max_width*/ None)
            )),
        ];
        if self.yolo_mode {
            lines.push(Line::from("permissions: YOLO mode"));
        }
        lines
    }
}
