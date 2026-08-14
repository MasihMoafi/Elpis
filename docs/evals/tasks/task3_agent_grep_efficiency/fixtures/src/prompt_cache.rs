use crate::errors::{ElpisError, Result};
use crate::config::Config;

pub trait PromptCache {
    fn hit_rate(&self) -> f64;
    fn update(&mut self, cached: usize, total: usize);
}

pub struct PromptCacheManager {
    pub cached_tokens: usize,
    pub total_input_tokens: usize,
    pub explicit_mode: bool,
}

impl PromptCache for PromptCacheManager {
    fn hit_rate(&self) -> f64 {
        if self.total_input_tokens == 0 {
            0.0
        } else {
            (self.cached_tokens as f64 / self.total_input_tokens as f64) * 100.0
        }
    }

    fn update(&mut self, cached: usize, total: usize) {
        self.cached_tokens += cached;
        self.total_input_tokens += total;
    }
}

impl PromptCacheManager {
    pub fn new(cfg: &Config) -> Self {
        Self {
            cached_tokens: 0,
            total_input_tokens: 0,
            explicit_mode: cfg.explicit_prompt_cache,
        }
    }

    pub fn plan_breakpoints(&self, epoch: usize) -> Result<Vec<String>> {
        let mut bps = vec!["stable_prefix".to_string()];
        if epoch > 0 {
            bps.push(format!("[elpis.context-prune.epoch {}]", epoch));
        }
        Ok(bps)
    }
}
