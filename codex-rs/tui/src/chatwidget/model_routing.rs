// Modified from OpenAI Codex (Apache-2.0) by the Elpis project.
//! Shared `/model` Auto tier identifiers. Routing itself runs in core, where
//! Terra can evaluate the live provider catalog before the user turn starts.

pub(crate) const LUNA_MODEL: &str = "gpt-5.6-luna";
pub(crate) const TERRA_MODEL: &str = "gpt-5.6-terra";
pub(crate) const SOL_MODEL: &str = "gpt-5.6-sol";
