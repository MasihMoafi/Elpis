use std::env;
use std::fs;
use std::path::Path;
use std::path::PathBuf;
use std::str::FromStr;

use anyhow::Context;
use anyhow::Result;
use anyhow::bail;
use base64::Engine as _;
use base64::engine::general_purpose;
use codex_terminal_detection::Multiplexer;
use codex_terminal_detection::TerminalInfo;
use codex_terminal_detection::TerminalName;
use codex_terminal_detection::terminal_info;
use image::imageops::FilterType;

use super::sixel;

const ESC: &str = "\x1b";
const ST: &str = "\x1b\\";
const KITTY_CHUNK_SIZE: usize = 4096;
const SIXEL_CACHE_VERSION: &str = "v2";
const ITERM2_KITTY_MIN_VERSION: (u64, u64, u64) = (3, 6, 0);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ImageProtocol {
    Kitty,
    KittyLocalFile,
    Sixel,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum PetImageSupport {
    Supported(ImageProtocol),
    Unsupported(PetImageUnsupportedReason),
}

impl PetImageSupport {
    pub(crate) fn protocol(self) -> Option<ImageProtocol> {
        match self {
            Self::Supported(protocol) => Some(protocol),
            Self::Unsupported(_) => None,
        }
    }

    pub(crate) fn unsupported_message(self) -> Option<&'static str> {
        match self {
            Self::Supported(_) => None,
            Self::Unsupported(reason) => Some(reason.message()),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum PetImageUnsupportedReason {
    Tmux,
    Zellij,
    Iterm2TooOld,
    Terminal,
}

impl PetImageUnsupportedReason {
    fn message(self) -> &'static str {
        match self {
            Self::Tmux => {
                "Pets are disabled in tmux. Terminal images don’t stay pane-local in tmux and can corrupt scrollback or move between panes. Run Codex outside tmux to use pets."
            }
            Self::Zellij => {
                "Pets are disabled in Zellij. Terminal images don’t stay reliably pane-local in Zellij. Run Codex outside Zellij to use pets."
            }
            Self::Iterm2TooOld => {
                "Pets require iTerm2 3.6 or newer. Upgrade iTerm2 to use terminal pets."
            }
            Self::Terminal => {
                "Pets aren’t available in this terminal. Terminal pets need image support, and this terminal environment doesn’t expose a supported image protocol. Try a terminal with Kitty graphics or Sixel support, or run Codex outside tmux."
            }
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProtocolSelection {
    Auto,
    Kitty,
    Sixel,
}

impl ProtocolSelection {
    pub(crate) fn resolve(self) -> PetImageSupport {
        match self {
            Self::Kitty => PetImageSupport::Supported(ImageProtocol::Kitty),
            Self::Sixel => PetImageSupport::Supported(ImageProtocol::Sixel),
            Self::Auto => detect_pet_image_support(),
        }
    }
}

impl FromStr for ProtocolSelection {
    type Err = anyhow::Error;

    fn from_str(value: &str) -> Result<Self> {
        match value {
            "auto" => Ok(Self::Auto),
            "kitty" => Ok(Self::Kitty),
            "sixel" => Ok(Self::Sixel),
            other => bail!("unknown protocol {other}; expected auto, kitty, or sixel"),
        }
    }
}

pub(crate) fn detect_pet_image_support() -> PetImageSupport {
    if env::var_os("TMUX").is_some() || env::var_os("TMUX_PANE").is_some() {
        return PetImageSupport::Unsupported(PetImageUnsupportedReason::Tmux);
    }

    if env::var_os("ZELLIJ").is_some()
        || env::var_os("ZELLIJ_SESSION_NAME").is_some()
        || env::var_os("ZELLIJ_VERSION").is_some()
    {
        return PetImageSupport::Unsupported(PetImageUnsupportedReason::Zellij);
    }

    if env::var_os("KITTY_WINDOW_ID").is_some() {
        return PetImageSupport::Supported(ImageProtocol::Kitty);
    }

    if env::var_os("WEZTERM_EXECUTABLE").is_some() || env::var_os("WEZTERM_VERSION").is_some() {
        return PetImageSupport::Supported(ImageProtocol::Kitty);
    }

    pet_image_support_for_terminal(&terminal_info())
}

fn pet_image_support_for_terminal(info: &TerminalInfo) -> PetImageSupport {
    match info.multiplexer {
        Some(Multiplexer::Tmux { .. }) => {
            return PetImageSupport::Unsupported(PetImageUnsupportedReason::Tmux);
        }
        Some(Multiplexer::Zellij { .. }) => {
            return PetImageSupport::Unsupported(PetImageUnsupportedReason::Zellij);
        }
        None => {}
    }

    if supports_iterm2_kitty_graphics(info) {
        return PetImageSupport::Supported(ImageProtocol::KittyLocalFile);
    }

    if is_iterm2_terminal(info) {
        return PetImageSupport::Unsupported(PetImageUnsupportedReason::Iterm2TooOld);
    }

    if supports_kitty_graphics(info) {
        return PetImageSupport::Supported(ImageProtocol::Kitty);
    }

    if supports_sixel(info) {
        return PetImageSupport::Supported(ImageProtocol::Sixel);
    }

    PetImageSupport::Unsupported(PetImageUnsupportedReason::Terminal)
}

fn supports_iterm2_kitty_graphics(info: &TerminalInfo) -> bool {
    is_iterm2_terminal(info)
        && version_is_at_least(
            info.version.as_deref(),
            /*minimum*/ ITERM2_KITTY_MIN_VERSION,
        )
}

fn is_iterm2_terminal(info: &TerminalInfo) -> bool {
    matches!(info.name, TerminalName::Iterm2)
        || terminal_field_contains(info.term_program.as_deref(), "iterm")
}

fn supports_kitty_graphics(info: &TerminalInfo) -> bool {
    matches!(
        info.name,
        TerminalName::Ghostty | TerminalName::Kitty | TerminalName::WezTerm
    ) || terminal_field_contains(info.term.as_deref(), "kitty")
        || terminal_field_contains(info.term.as_deref(), "ghostty")
        || terminal_field_contains(info.term.as_deref(), "wezterm")
        || terminal_field_contains(info.term_program.as_deref(), "kitty")
        || terminal_field_contains(info.term_program.as_deref(), "ghostty")
        || terminal_field_contains(info.term_program.as_deref(), "wezterm")
}

fn supports_sixel(info: &TerminalInfo) -> bool {
    matches!(info.name, TerminalName::WindowsTerminal)
        || terminal_field_contains(info.term.as_deref(), "sixel")
        || terminal_field_contains(info.term.as_deref(), "mlterm")
        || terminal_field_contains(info.term.as_deref(), "foot")
}

fn terminal_field_contains(value: Option<&str>, needle: &str) -> bool {
    value.is_some_and(|value| value.to_ascii_lowercase().contains(needle))
}

fn version_is_at_least(version: Option<&str>, minimum: (u64, u64, u64)) -> bool {
    parse_dotted_version(version).is_some_and(|version| version >= minimum)
}

fn parse_dotted_version(version: Option<&str>) -> Option<(u64, u64, u64)> {
    let version = version?;
    let mut parts = version.split('.');
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next().unwrap_or("0").parse().ok()?;
    let patch = parts.next().unwrap_or("0").parse().ok()?;

    if parts.next().is_some() {
        return None;
    }

    Some((major, minor, patch))
}

pub fn kitty_delete_image(image_id: u32) -> String {
    wrap_for_tmux_if_needed(&format!("{ESC}_Ga=d,d=I,i={image_id},q=2;{ST}"))
}

pub fn kitty_transmit_png_with_id(
    path: &Path,
    columns: u16,
    rows: u16,
    image_id: Option<u32>,
) -> Result<String> {
    let png = fs::read(path).with_context(|| format!("read {}", path.display()))?;
    let payload = general_purpose::STANDARD.encode(png);
    let chunks = payload
        .as_bytes()
        .chunks(KITTY_CHUNK_SIZE)
        .collect::<Vec<_>>();

    let mut command = String::new();
    for (index, chunk) in chunks.iter().enumerate() {
        let chunk = std::str::from_utf8(chunk).context("base64 payload is not valid UTF-8")?;
        let has_more = index + 1 < chunks.len();
        let more_flag = u8::from(has_more);
        if index == 0 {
            let image_id = kitty_image_id_arg(image_id);
            command.push_str(&format!(
                "{ESC}_Ga=T,t=d,f=100,c={columns},r={rows},q=2{image_id},m={more_flag};{chunk}{ST}",
            ));
        } else {
            command.push_str(&format!("{ESC}_Gm={more_flag};{chunk}{ST}"));
        }
    }

    Ok(wrap_for_tmux_if_needed(&command))
}

pub fn kitty_transmit_png_file_with_id(
    path: &Path,
    columns: u16,
    rows: u16,
    image_id: Option<u32>,
) -> Result<String> {
    let path = path
        .canonicalize()
        .with_context(|| format!("canonicalize {}", path.display()))?;
    let payload = general_purpose::STANDARD.encode(path.to_string_lossy().as_bytes());
    let image_id = kitty_image_id_arg(image_id);
    let command = format!("{ESC}_Ga=T,t=f,f=100,c={columns},r={rows},q=2{image_id};{payload}{ST}");

    Ok(wrap_for_tmux_if_needed(&command))
}

fn kitty_image_id_arg(image_id: Option<u32>) -> String {
    image_id
        .map(|image_id| format!(",i={image_id}"))
        .unwrap_or_default()
}

fn wrap_for_tmux_if_needed(command: &str) -> String {
    if env::var_os("TMUX").is_none() {
        return command.to_string();
    }

    let escaped = command.replace(ESC, "\x1b\x1b");
    format!("{ESC}Ptmux;{escaped}{ST}")
}

pub fn sixel_frame(frame_path: &Path, cache_dir: &Path, height_px: u16) -> Result<PathBuf> {
    fs::create_dir_all(cache_dir).with_context(|| format!("create {}", cache_dir.display()))?;

    let stem = frame_path
        .file_stem()
        .and_then(|stem| stem.to_str())
        .context("frame path has no valid file stem")?;
    let path = cache_dir.join(format!("{stem}_h{height_px}_{SIXEL_CACHE_VERSION}.six"));
    if path.exists() {
        return Ok(path);
    }

    let frame =
        image::open(frame_path).with_context(|| format!("read {}", frame_path.display()))?;
    let height = u32::from(height_px).max(1);
    let width = ((u64::from(frame.width()) * u64::from(height)) / u64::from(frame.height()))
        .try_into()
        .unwrap_or(u32::MAX)
        .max(1);
    let rgba = frame.resize(width, height, FilterType::Lanczos3).to_rgba8();
    let (width, height) = rgba.dimensions();
    let sixel = sixel::encode_rgba(&rgba.into_raw(), width, height)?;

    fs::write(&path, sixel).with_context(|| format!("write {}", path.display()))?;
    Ok(path)
}
