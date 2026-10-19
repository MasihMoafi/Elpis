//! The owner's manual credits snapshot gate. This does not query or meter the live balance.

use std::io::Read;
use std::path::Path;

use crate::GatewayError;
use crate::route::Route;

/// Re-read before every paid credits request. Model discovery remains available even when
/// spending is blocked. Missing or invalid snapshots fail closed only for this provider.
pub(crate) fn check(route: &Route, file: Option<&Path>) -> Result<(), GatewayError> {
    if route.provider_id != "anthropic-credits" {
        return Ok(());
    }
    let invalid = || {
        GatewayError::forbidden(
            "Anthropic credits budget is unavailable or invalid; update elpis/anthropic-credits-budget.env in your config directory before spending credits",
        )
    };
    let file = std::fs::File::open(file.ok_or_else(invalid)?).map_err(|_| invalid())?;
    let mut text = String::new();
    file.take(16_385)
        .read_to_string(&mut text)
        .map_err(|_| invalid())?;
    if text.len() > 16_384 {
        return Err(invalid());
    }
    let value = |name: &str| -> Option<f64> {
        let mut rows = text.lines().filter_map(|line| {
            let line = line.split('#').next()?.trim();
            let (key, value) = line
                .strip_prefix("export ")
                .unwrap_or(line)
                .split_once('=')?;
            (key.trim() == name).then_some(value.trim())
        });
        let value = rows.next()?.parse::<f64>().ok()?;
        (rows.next().is_none() && value.is_finite() && value >= 0.0).then_some(value)
    };
    let left = value("ANTHROPIC_CREDITS_LEFT_USD").ok_or_else(invalid)?;
    let buffer = value("ANTHROPIC_CREDITS_BUFFER_USD").ok_or_else(invalid)?;
    if left <= buffer {
        return Err(GatewayError::forbidden(format!(
            "Anthropic credits budget blocks this request: the recorded balance (${left:.2}) is at or below the reserved buffer (${buffer:.2}); update the snapshot before spending credits"
        )));
    }
    Ok(())
}
