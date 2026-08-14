use elpis_fixture::*;

#[tokio::test]
async fn test_prune_cycle_execution() {
    let mut ledger = ContextLedger::new(258400);
    let mut pruner = ContextPruner::new();
    ledger.total_tokens = 90000; // > 30%

    let res = pruner.run_cycle(&mut ledger).await;
    assert!(res.is_ok());
    assert_eq!(pruner.current_epoch, 1);
}

#[test]
fn test_prompt_cache_hit_rate() {
    let cfg = Config::default();
    let mut pc = PromptCacheManager::new(&cfg);
    pc.update(8000, 10000);
    assert_eq!(pc.hit_rate(), 80.0);
}

#[test]
fn test_config_defaults() {
    let cfg = Config::default();
    assert!(!cfg.explicit_prompt_cache);
    assert_eq!(cfg.trigger_threshold_pct, 30.0);
}
