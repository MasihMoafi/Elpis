use std::collections::HashMap;
use crate::errors::Result;

pub struct ContextLedger {
    pub total_tokens: usize,
    pub max_window: usize,
    pub entries: Vec<String>,
    pub metadata: HashMap<String, String>,
}

impl ContextLedger {
    pub fn new(max_window: usize) -> Self {
        Self {
            total_tokens: 0,
            max_window,
            entries: Vec::new(),
            metadata: HashMap::new(),
        }
    }

    pub fn record(ledger: &mut ContextLedger, entry: &str) {
        ledger.entries.push(entry.to_string());
        ledger.total_tokens += entry.len() / 4;
    }

    pub fn get_occupancy(&self) -> f64 {
        if self.max_window == 0 {
            0.0
        } else {
            (self.total_tokens as f64 / self.max_window as f64) * 100.0
        }
    }

    pub fn inspect_ledger(&self) -> Result<&[String]> {
        Ok(&self.entries)
    }
}
