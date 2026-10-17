//! Session headers, onboarding guidance, and transcript cards.

use super::*;
use crate::line_truncation::line_width;
use crate::line_truncation::truncate_line_with_ellipsis_if_overflow;
use crate::style::BYPASS_PERMISSIONS_LABEL;
use crate::style::accent_color;
use crate::width::display_width;

/// Render `lines` inside a border whose inner width is at least `inner_width`.
///
/// This is useful when callers have already clamped their content to a
/// specific width and want the border math centralized here instead of
/// duplicating padding logic in the TUI widgets themselves.
pub(crate) fn with_border_with_inner_width(
    lines: Vec<Line<'static>>,
    inner_width: usize,
) -> Vec<Line<'static>> {
    let max_line_width = lines.iter().map(line_width).max().unwrap_or(0);
    let content_width = inner_width.max(max_line_width);

    let mut out = Vec::with_capacity(lines.len() + 2);
    let border_inner_width = content_width + 2;
    out.push(vec![format!("╭{}╮", "─".repeat(border_inner_width)).dim()].into());

    for line in lines.into_iter() {
        let used_width = line_width(&line);
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

/// Brand title shared by the session header and the status card; each owns its own indentation.
pub(crate) fn codex_title(version: &str) -> Vec<Span<'static>> {
    // Elpis: the ember, the Elpis name and the Elpis release, not ">_ OpenAI Codex". This one
    // title serves the session header and the /status card.
    let version = if version == crate::version::CODEX_CLI_VERSION {
        crate::branding::ELPIS_VERSION
    } else {
        version
    };
    codex_title_with_palette(
        version,
        crate::branding::wordmark_palette(crate::terminal_palette::default_bg()),
    )
}

fn codex_title_with_palette(version: &str, palette: [(u8, u8, u8); 5]) -> Vec<Span<'static>> {
    let mut spans = vec![">_ ".fg(accent_color())];
    spans.extend(
        crate::branding::CODEX_RUNTIME_TITLE
            .chars()
            .zip(palette.into_iter().cycle())
            .map(|(letter, color)| {
                Span::from(letter.to_string())
                    .fg(crate::terminal_palette::best_color(color))
                    .bold()
            }),
    );
    spans.push(format!(" (v{version})").dim());
    spans
}

#[derive(Debug)]
struct TooltipHistoryCell {
    tip: String,
    cwd: PathBuf,
}

impl TooltipHistoryCell {
    fn new(tip: String, cwd: &Path) -> Self {
        Self {
            tip,
            cwd: cwd.to_path_buf(),
        }
    }
}

impl HistoryCell for TooltipHistoryCell {
    fn display_lines(&self, width: u16) -> Vec<Line<'static>> {
        visible_lines(self.display_hyperlink_lines(width))
    }

    fn display_hyperlink_lines(&self, width: u16) -> Vec<HyperlinkLine> {
        let indent = "  ";
        let indent_width = display_width(indent);
        let wrap_width = usize::from(width.max(1))
            .saturating_sub(indent_width)
            .max(1);
        let lines = crate::tooltips::render_tooltip_lines(&self.tip, wrap_width, &self.cwd);

        prefix_hyperlink_lines(lines, indent.into(), indent.into())
    }

    fn transcript_hyperlink_lines(&self, width: u16) -> Vec<HyperlinkLine> {
        self.display_hyperlink_lines(width)
    }

    fn raw_lines(&self) -> Vec<Line<'static>> {
        vec![Line::from(format!("Tip: {}", self.tip))]
    }
}

/// Startup metadata, including prior-session summaries and available usage resets.
#[derive(Debug)]
pub(crate) struct SessionNoticeCell(pub(crate) PlainHistoryCell);

impl HistoryCell for SessionNoticeCell {
    fn display_lines(&self, width: u16) -> Vec<Line<'static>> {
        self.0.display_lines(width)
    }

    fn raw_lines(&self) -> Vec<Line<'static>> {
        self.0.raw_lines()
    }
}

#[derive(Debug)]
pub struct SessionInfoCell(CompositeHistoryCell);

/// Fullscreen transcript presentation omits tips; scrollback retains the original cells.
pub(crate) fn fullscreen_session_lines(
    cell: &dyn HistoryCell,
    width: u16,
    detailed: bool,
    mode: HistoryRenderMode,
) -> Vec<HyperlinkLine> {
    if let Some(info) = cell.as_any().downcast_ref::<SessionInfoCell>() {
        let mut lines = Vec::new();
        for part in &info.0.parts {
            if part.as_any().is::<TooltipHistoryCell>() {
                continue;
            }
            let part_lines = fullscreen_session_lines(part.as_ref(), width, detailed, mode);
            if !part_lines.is_empty() {
                if !lines.is_empty() {
                    lines.push(HyperlinkLine::from(""));
                }
                lines.extend(part_lines);
            }
        }
        lines
    } else if detailed || mode == HistoryRenderMode::Rich {
        cell.retained_hyperlink_lines(width, detailed)
    } else {
        cell.display_hyperlink_lines_for_mode(width, mode)
    }
}

impl HistoryCell for SessionInfoCell {
    fn compact_hyperlink_lines(&self, width: u16) -> Vec<HyperlinkLine> {
        self.0.compact_hyperlink_lines(width)
    }

    fn display_lines(&self, width: u16) -> Vec<Line<'static>> {
        self.0.display_lines(width)
    }

    fn display_hyperlink_lines(&self, width: u16) -> Vec<HyperlinkLine> {
        self.0.display_hyperlink_lines(width)
    }

    fn desired_height(&self, width: u16) -> u16 {
        self.0.desired_height(width)
    }

    fn transcript_lines(&self, width: u16) -> Vec<Line<'static>> {
        self.0.transcript_lines(width)
    }

    fn transcript_hyperlink_lines(&self, width: u16) -> Vec<HyperlinkLine> {
        self.0.transcript_hyperlink_lines(width)
    }

    fn raw_lines(&self) -> Vec<Line<'static>> {
        self.0.raw_lines()
    }

    fn transcript_animation_tick(&self) -> Option<u64> {
        self.0
            .parts
            .iter()
            .find_map(|part| part.transcript_animation_tick())
    }
}

#[expect(
    clippy::too_many_arguments,
    reason = "keep local preferences separate while the legacy Config parameter is still required"
)]
pub(crate) fn new_session_info(
    config: &Config,
    local_settings: &crate::local_settings::LocalSettings,
    requested_model: &str,
    model_display_name: &str,
    session: &ThreadSessionState,
    is_first_event: bool,
    tooltip_override: Option<String>,
    auth_plan: Option<PlanType>,
) -> SessionInfoCell {
    // Header rendered as history (so it appears at the very top).
    let header = SessionHeaderHistoryCell::new(
        model_display_name.to_string(),
        session.reasoning_effort.clone(),
        config.cwd.to_path_buf(),
        CODEX_CLI_VERSION,
    )
    .with_animations(local_settings.tui.animations && local_settings.tui.effects.shimmer)
    .with_yolo_mode(has_yolo_permissions(
        session.approval_policy,
        &session.permission_profile,
    ))
    .with_bypass_mode(codex_protocol::models::bypass_permissions_active(
        session.approval_policy.to_core(),
        &session.permission_profile,
        session.active_permission_profile.as_ref(),
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
                // Elpis: product name in the help copy.
                " - create an AGENTS.md file with instructions for Elpis".dim(),
            ]),
            Line::from(vec![
                "  ".into(),
                // Elpis: /usage replaces the hidden /status.
                "/usage".into(),
                " - show this session's usage and limits".dim(),
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
        ];

        parts.push(Box::new(PlainHistoryCell { lines: help_lines }));
    } else {
        if local_settings.tui.show_tooltips
            && let Some(tooltips) = tooltip_override
                .or_else(|| tooltips::get_tooltip(auth_plan, &local_settings.tui.keymap))
                .map(|tip| TooltipHistoryCell::new(tip, &config.cwd))
        {
            parts.push(Box::new(tooltips));
        }
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

/// Elpis: "Permissions updated to …", in red when the new mode is Bypass permissions.
pub(crate) fn new_permissions_updated_event(label: &str, bypass: bool) -> PlainHistoryCell {
    let message = format!("Permissions updated to {label}");
    if !bypass {
        return new_info_event(message, /*hint*/ None);
    }
    PlainHistoryCell {
        lines: vec![Line::from(vec![
            "• ".dim(),
            Span::from(message).style(crate::style::status_style(
                crate::style::StatusTone::Failure,
            )),
        ])],
    }
}

/// Elpis: whether this config runs in Bypass permissions, shown in red in the header.
pub(crate) fn is_bypass_mode(config: &Config) -> bool {
    codex_protocol::models::bypass_permissions_active(
        config.permissions.approval_policy.value(),
        config.permissions.permission_profile(),
        config.permissions.active_permission_profile().as_ref(),
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
/// Session banner with a model label already resolved for presentation by its caller.
#[derive(Debug)]
pub(crate) struct SessionHeaderHistoryCell {
    version: &'static str,
    model: String,
    reasoning_effort: Option<ReasoningEffortConfig>,
    directory: PathBuf,
    yolo_mode: bool,
    /// Elpis: Bypass permissions replaces the YOLO line with a red one.
    bypass_mode: bool,
    animation_origin: Option<Instant>,
}

impl SessionHeaderHistoryCell {
    pub(crate) fn new(
        model: String,
        reasoning_effort: Option<ReasoningEffortConfig>,
        directory: PathBuf,
        version: &'static str,
    ) -> Self {
        Self {
            // Elpis: titles show the Elpis release, not the vendored Codex version.
            version: crate::branding::title_version(version),
            model,
            reasoning_effort,
            directory,
            yolo_mode: false,
            bypass_mode: false,
            animation_origin: None,
        }
    }

    pub(crate) fn with_animations(mut self, enabled: bool) -> Self {
        self.animation_origin = enabled.then(Instant::now);
        self
    }

    pub(crate) fn with_yolo_mode(mut self, yolo_mode: bool) -> Self {
        self.yolo_mode = yolo_mode;
        self
    }

    pub(crate) fn with_bypass_mode(mut self, bypass_mode: bool) -> Self {
        self.bypass_mode = bypass_mode;
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
            if display_width(formatted.as_str()) > max_width {
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
    fn transcript_animation_tick(&self) -> Option<u64> {
        self.animation_origin
            .map(|origin| (origin.elapsed().as_millis() / 100) as u64)
    }

    fn display_lines(&self, width: u16) -> Vec<Line<'static>> {
        let width = usize::from(width);
        let mut title = vec!["  ".into()];
        let palette = crate::branding::wordmark_palette_at(
            crate::terminal_palette::default_bg(),
            self.animation_origin
                .map(|origin| origin.elapsed().as_millis())
                .unwrap_or(0),
        );
        title.extend(codex_title_with_palette(self.version, palette));
        let mut lines = vec![
            Line::default(),
            Line::from(title),
            Line::from(vec![
                "     ".into(),
                self.format_directory(Some(width.saturating_sub(/*rhs*/ 5)))
                    .dim(),
            ]),
        ];
        if self.bypass_mode {
            lines.push(Line::from(vec![
                "  permissions: ".dim(),
                Span::from(BYPASS_PERMISSIONS_LABEL).style(crate::style::status_style(
                    crate::style::StatusTone::Failure,
                )),
            ]));
        } else if self.yolo_mode {
            lines.push(Line::from(vec![
                "  permissions: ".dim(),
                // Elpis: YOLO reads as a warning, as in v0.3.0.
                Span::from("YOLO mode").style(crate::style::status_style(
                    crate::style::StatusTone::Attention,
                )),
            ]));
        }
        lines
            .into_iter()
            .map(|line| truncate_line_with_ellipsis_if_overflow(line, width))
            .collect()
    }

    fn raw_lines(&self) -> Vec<Line<'static>> {
        let mut lines = vec![
            // Elpis: product title.
            Line::from(format!(
                "{} (v{})",
                crate::branding::CODEX_RUNTIME_TITLE,
                self.version
            )),
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
        if self.bypass_mode {
            lines.push(Line::from(format!(
                "permissions: {BYPASS_PERMISSIONS_LABEL}"
            )));
        } else if self.yolo_mode {
            lines.push(Line::from("permissions: YOLO mode"));
        }
        lines
    }
}

#[cfg(test)]
#[path = "session_transcript_tests.rs"]
mod transcript_tests;
