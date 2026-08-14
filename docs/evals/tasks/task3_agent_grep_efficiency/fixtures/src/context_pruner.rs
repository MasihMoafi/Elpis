use crate::errors::{ElpisError, Result};
use crate::ledger::ContextLedger;
use crate::prompt_cache::PromptCacheManager;

pub struct ContextPruner {
    pub current_epoch: usize,
    pub trigger_threshold_pct: f64,
    pub target_threshold_pct: f64,
    pub is_cooling: bool,
}

impl ContextPruner {
    pub fn new() -> Self {
        Self {
            current_epoch: 0,
            trigger_threshold_pct: 30.0,
            target_threshold_pct: 20.0,
            is_cooling: false,
        }
    }

    pub async fn run_cycle(&mut self, ledger: &mut ContextLedger) -> Result<usize> {
        let occ = ledger.get_occupancy();
        if occ < self.trigger_threshold_pct {
            return Ok(0);
        }
        self.execute_pressure_prune(ledger).await
    }

    pub async fn execute_pressure_prune(&mut self, ledger: &mut ContextLedger) -> Result<usize> {
        self.current_epoch += 1;
        let epoch_marker = format!("[elpis.context-prune.epoch {}]", self.current_epoch);
        ContextLedger::record(ledger, &epoch_marker);
        self.is_cooling = true;
        Ok(self.current_epoch)
    }

    pub fn should_cool(&self) -> bool {
        self.is_cooling
    }
}
