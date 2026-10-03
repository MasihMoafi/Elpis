//! Ambient terminal pets configured from the /pets slash command.
//!
//! The TUI treats built-in and custom pets differently on purpose:
//! built-in pets are versioned application assets fetched on demand into a
//! managed CODEX_HOME cache, while custom pets remain entirely user-owned data
//! under `$CODEX_HOME/pets/<pet-id>/pet.json` or legacy avatar directories.
//!
//! This module owns the TUI-facing contracts around that split:
//! resolving a selected pet id, preparing frames for terminal image protocols,
//! rendering the ambient sprite and picker preview, and preserving enough
//! metadata for `/pets` to behave like a first-class configuration surface.
//! It prepares built-in assets before loading pets, but does not own config
//! persistence or popup orchestration; callers must persist the final selection
//! only after the load succeeds.

use std::io::Write;

mod ambient;
mod asset_pack;
mod catalog;
mod frames;
mod image_protocol;
mod model;
mod picker;
mod preview;
mod sixel;

use anyhow::Context;
use anyhow::Result;
use codex_http_client::RouteAwareClientPool;
use codex_utils_absolute_path::AbsolutePathBuf;

use crate::tui::FrameRequester;

pub(crate) use ambient::AmbientPet;
pub(crate) use ambient::AmbientPetDraw;
pub(crate) use ambient::PetNotificationKind;
pub(crate) use asset_pack::builtin_spritesheet_path;
#[cfg(test)]
pub(crate) use asset_pack::write_test_pack;
#[cfg(test)]
pub(crate) use image_protocol::ImageProtocol;
pub(crate) use image_protocol::PetImageSupport;
#[cfg(test)]
pub(crate) use image_protocol::PetImageUnsupportedReason;
#[cfg(not(test))]
pub(crate) use image_protocol::detect_pet_image_support;
pub(crate) use picker::PET_PICKER_VIEW_ID;
pub(crate) use picker::build_pet_picker_params;
pub(crate) use preview::PetPickerPreviewState;

pub(crate) const DEFAULT_PET_ID: &str = "codex";
pub(crate) const DISABLED_PET_ID: &str = "disabled";

/// Ensure that a selected built-in pet has a locally cached spritesheet.
///
/// Custom pets are intentionally a no-op here because their source of truth is
/// already local. Preparing this before loading keeps first-use preview and
/// persistence failures at the asset-fetch boundary rather than surfacing as
/// deeper image-loading errors.
async fn ensure_builtin_pack_for_pet(
    pet_id: &str,
    codex_home: &std::path::Path,
    http_client: &RouteAwareClientPool,
) -> Result<()> {
    if let Some(pet) = catalog::builtin_pet(pet_id) {
        asset_pack::ensure_builtin_pet(codex_home, pet, http_client).await?;
    }
    Ok(())
}

/// Prepare a pet's built-in assets and load its synchronous state off the runtime.
pub(crate) async fn load_pet_with_assets(
    pet_id: String,
    codex_home: AbsolutePathBuf,
    frame_requester: FrameRequester,
    animations_enabled: bool,
    http_client: &RouteAwareClientPool,
) -> Result<AmbientPet> {
    ensure_builtin_pack_for_pet(&pet_id, &codex_home, http_client).await?;
    tokio::task::spawn_blocking(move || {
        AmbientPet::load(
            Some(&pet_id),
            &codex_home,
            frame_requester,
            animations_enabled,
        )
    })
    .await
    .context("join pet load task")?
}

#[derive(Debug)]
pub(crate) enum PetImageRenderError {
    Terminal(std::io::Error),
    Asset(anyhow::Error),
}

impl std::fmt::Display for PetImageRenderError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Terminal(err) => write!(f, "terminal image write failed: {err}"),
            Self::Asset(err) => write!(f, "pet image asset unavailable: {err}"),
        }
    }
}

impl std::error::Error for PetImageRenderError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Terminal(err) => Some(err),
            Self::Asset(err) => Some(err.as_ref()),
        }
    }
}

impl From<std::io::Error> for PetImageRenderError {
    fn from(err: std::io::Error) -> Self {
        Self::Terminal(err)
    }
}

pub(crate) fn render_ambient_pet_image(
    writer: &mut impl Write,
    state: &mut PetImageRenderState,
    request: Option<AmbientPetDraw>,
) -> std::result::Result<(), PetImageRenderError> {
    render_pet_image(writer, state, /*image_id*/ 0xC0DE, request)
}

pub(crate) fn render_pet_picker_preview_image(
    writer: &mut impl Write,
    state: &mut PetImageRenderState,
    request: Option<AmbientPetDraw>,
) -> std::result::Result<(), PetImageRenderError> {
    render_pet_image(writer, state, /*image_id*/ 0xC0DF, request)
}

#[derive(Debug, Default)]
pub(crate) struct PetImageRenderState {
    last_sixel_clear_area: Option<SixelClearArea>,
    last_protocol: Option<image_protocol::ImageProtocol>,
}

fn render_pet_image(
    writer: &mut impl Write,
    state: &mut PetImageRenderState,
    image_id: u32,
    request: Option<AmbientPetDraw>,
) -> std::result::Result<(), PetImageRenderError> {
    use crossterm::cursor::MoveTo;
    use crossterm::cursor::RestorePosition;
    use crossterm::cursor::SavePosition;
    use crossterm::queue;
    use image_protocol::ImageProtocol;

    let Some(request) = request else {
        if state.last_protocol.take().is_some_and(is_kitty_protocol) {
            write!(writer, "{}", image_protocol::kitty_delete_image(image_id))?;
        }
        if let Some(area) = state.last_sixel_clear_area.take() {
            queue!(writer, SavePosition)?;
            clear_sixel_area(writer, area)?;
            queue!(writer, RestorePosition)?;
        }
        writer.flush()?;
        return Ok(());
    };

    if state.last_protocol.take().is_some_and(is_kitty_protocol)
        || is_kitty_protocol(request.protocol)
    {
        write!(writer, "{}", image_protocol::kitty_delete_image(image_id))?;
    }
    state.last_protocol = Some(request.protocol);

    let payload = match request.protocol {
        ImageProtocol::Kitty => AmbientPetPayload::Text(
            image_protocol::kitty_transmit_png_with_id(
                &request.frame,
                request.columns,
                request.rows,
                Some(image_id),
            )
            .map_err(PetImageRenderError::Asset)?,
        ),
        ImageProtocol::KittyLocalFile => AmbientPetPayload::Text(
            image_protocol::kitty_transmit_png_file_with_id(
                &request.frame,
                request.columns,
                request.rows,
                Some(image_id),
            )
            .map_err(PetImageRenderError::Asset)?,
        ),
        ImageProtocol::Sixel => {
            let path =
                image_protocol::sixel_frame(&request.frame, &request.sixel_dir, request.height_px)
                    .map_err(PetImageRenderError::Asset)?;
            let sixel = std::fs::read(&path)
                .with_context(|| format!("read {}", path.display()))
                .map_err(PetImageRenderError::Asset)?;
            AmbientPetPayload::Bytes(sixel)
        }
    };

    queue!(writer, SavePosition)?;
    let current_sixel_clear_area = if matches!(request.protocol, ImageProtocol::Sixel) {
        Some(SixelClearArea::from(&request))
    } else {
        None
    };
    if let Some(previous_area) = state.last_sixel_clear_area.take()
        && Some(previous_area) != current_sixel_clear_area
    {
        clear_sixel_area(writer, previous_area)?;
    }
    if let Some(area) = current_sixel_clear_area {
        clear_sixel_area(writer, area)?;
        state.last_sixel_clear_area = Some(area);
    }
    queue!(writer, MoveTo(request.x, request.y))?;
    match payload {
        AmbientPetPayload::Text(payload) => write!(writer, "{payload}")?,
        AmbientPetPayload::Bytes(payload) => writer.write_all(&payload)?,
    }
    queue!(writer, RestorePosition)?;
    writer.flush()?;
    Ok(())
}

enum AmbientPetPayload {
    Text(String),
    Bytes(Vec<u8>),
}

fn is_kitty_protocol(protocol: image_protocol::ImageProtocol) -> bool {
    matches!(
        protocol,
        image_protocol::ImageProtocol::Kitty | image_protocol::ImageProtocol::KittyLocalFile
    )
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct SixelClearArea {
    x: u16,
    clear_top_y: u16,
    clear_bottom_y: u16,
    columns: u16,
}

impl From<&AmbientPetDraw> for SixelClearArea {
    fn from(request: &AmbientPetDraw) -> Self {
        Self {
            x: request.x,
            clear_top_y: request.clear_top_y,
            clear_bottom_y: request.y.saturating_add(request.rows),
            columns: request.columns,
        }
    }
}

fn clear_sixel_area(writer: &mut impl Write, area: SixelClearArea) -> std::io::Result<()> {
    use crossterm::cursor::MoveTo;
    use crossterm::queue;

    let blank = " ".repeat(area.columns.into());
    for row in area.clear_top_y..area.clear_bottom_y {
        queue!(writer, MoveTo(area.x, row))?;
        write!(writer, "{blank}")?;
    }
    Ok(())
}
