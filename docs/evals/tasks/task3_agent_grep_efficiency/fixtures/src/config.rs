use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Config {
    pub explicit_prompt_cache: bool,
    pub trigger_threshold_pct: f64,
    pub target_threshold_pct: f64,
    pub max_batch_tokens: usize,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            explicit_prompt_cache: false,
            trigger_threshold_pct: 30.0,
            target_threshold_pct: 20.0,
            max_batch_tokens: 16384,
        }
    }
}
