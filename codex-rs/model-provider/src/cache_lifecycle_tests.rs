use super::*;
use std::time::{Duration, Instant};

#[test]
fn test_anthropic_default_policy() {
    let policy = ProviderCachePolicy::anthropic();
    assert_eq!(policy.ttl, Duration::from_secs(300));
    assert_eq!(policy.near_expiry_window, Duration::from_secs(30));
    assert_eq!(policy.min_tokens, 1024);
    assert_eq!(policy.provider_name, "anthropic");
    assert_eq!(policy.expiry_threshold(), Duration::from_secs(270));
}

#[test]
fn test_openai_default_policy() {
    let policy = ProviderCachePolicy::openai();
    assert_eq!(policy.ttl, Duration::from_secs(600));
    assert_eq!(policy.near_expiry_window, Duration::from_secs(60));
    assert_eq!(policy.min_tokens, 1024);
    assert_eq!(policy.provider_name, "openai");
    assert_eq!(policy.expiry_threshold(), Duration::from_secs(540));
}

#[test]
fn test_cache_state_transitions_anthropic_ttl() {
    let mut tracker = ProviderCacheTracker::new();
    let key = CacheKey::new("thread-123", "anthropic");
    let t0 = Instant::now();

    // Before any request: Cold
    assert_eq!(tracker.get_state(&key, t0), CacheState::Cold);
    assert!(tracker.get_state(&key, t0).is_cold());
    assert_eq!(tracker.remaining_ttl(&key, t0), None);

    // Record initial request at t0
    tracker.record_usage(&key, t0, 2000, 0, 2000);

    // At t0 + 100s: Hot
    let t100 = t0 + Duration::from_secs(100);
    assert_eq!(tracker.get_state(&key, t100), CacheState::Hot);
    assert!(tracker.get_state(&key, t100).is_hot());
    assert_eq!(
        tracker.remaining_ttl(&key, t100),
        Some(Duration::from_secs(200))
    );

    // At t0 + 269s: Still Hot (just before 270s threshold)
    let t269 = t0 + Duration::from_secs(269);
    assert_eq!(tracker.get_state(&key, t269), CacheState::Hot);

    // At t0 + 270s: NearExpiry (warning window: 30s remaining before 300s TTL)
    let t270 = t0 + Duration::from_secs(270);
    assert_eq!(tracker.get_state(&key, t270), CacheState::NearExpiry);
    assert!(tracker.get_state(&key, t270).is_near_expiry());
    assert_eq!(
        tracker.remaining_ttl(&key, t270),
        Some(Duration::from_secs(30))
    );

    // At t0 + 299s: NearExpiry (1s remaining)
    let t299 = t0 + Duration::from_secs(299);
    assert_eq!(tracker.get_state(&key, t299), CacheState::NearExpiry);
    assert_eq!(
        tracker.remaining_ttl(&key, t299),
        Some(Duration::from_secs(1))
    );

    // At t0 + 300s: Cold (TTL expired)
    let t300 = t0 + Duration::from_secs(300);
    assert_eq!(tracker.get_state(&key, t300), CacheState::Cold);
    assert!(tracker.get_state(&key, t300).is_cold());
    assert_eq!(tracker.remaining_ttl(&key, t300), Some(Duration::ZERO));

    // At t0 + 350s: Cold
    let t350 = t0 + Duration::from_secs(350);
    assert_eq!(tracker.get_state(&key, t350), CacheState::Cold);
    assert_eq!(tracker.remaining_ttl(&key, t350), Some(Duration::ZERO));
}

#[test]
fn test_ttl_refresh_on_subsequent_request() {
    let mut tracker = ProviderCacheTracker::new();
    let key = CacheKey::new("thread-abc", "anthropic");
    let t0 = Instant::now();

    // Initial write at t0
    tracker.record_usage(&key, t0, 1500, 0, 1500);

    // At t0 + 250s: Cache is still alive (Hot), make another request
    let t250 = t0 + Duration::from_secs(250);
    assert_eq!(tracker.get_state(&key, t250), CacheState::Hot);

    // Hit cache at t250
    let miss_reason = tracker.record_usage(&key, t250, 1600, 1500, 100);
    assert_eq!(miss_reason, CacheMissReason::Hit);

    // At t0 + 400s (150s after t250): Should still be Hot because TTL was refreshed at t250!
    let t400 = t0 + Duration::from_secs(400);
    assert_eq!(tracker.get_state(&key, t400), CacheState::Hot);
    assert_eq!(
        tracker.remaining_ttl(&key, t400),
        Some(Duration::from_secs(150))
    );

    // At t250 + 275s (t0 + 525s): NearExpiry
    let t525 = t0 + Duration::from_secs(525);
    assert_eq!(tracker.get_state(&key, t525), CacheState::NearExpiry);

    // At t250 + 301s (t0 + 551s): Expired / Cold
    let t551 = t0 + Duration::from_secs(551);
    assert_eq!(tracker.get_state(&key, t551), CacheState::Cold);
}

#[test]
fn test_cache_miss_detection_reasons() {
    let mut tracker = ProviderCacheTracker::new();
    let key = CacheKey::new("thread-miss", "anthropic");
    let t0 = Instant::now();

    // 1. Cold start detection
    let reason = tracker.detect_miss_reason(&key, t0, 2000, 0);
    assert_eq!(reason, CacheMissReason::ColdStart);

    // Record initial request
    tracker.record_usage(&key, t0, 2000, 0, 2000);

    // 2. Below token threshold (< 1024)
    let t10 = t0 + Duration::from_secs(10);
    let reason_low_tokens = tracker.detect_miss_reason(&key, t10, 500, 0);
    assert_eq!(
        reason_low_tokens,
        CacheMissReason::BelowTokenThreshold {
            prompt_tokens: 500,
            min_required: 1024,
        }
    );

    // 3. Cache Hit
    let reason_hit = tracker.detect_miss_reason(&key, t10, 2200, 2000);
    assert_eq!(reason_hit, CacheMissReason::Hit);

    // 4. TTL Expired Miss (at t0 + 310s)
    let t310 = t0 + Duration::from_secs(310);
    let reason_expired = tracker.detect_miss_reason(&key, t310, 2200, 0);
    assert_eq!(
        reason_expired,
        CacheMissReason::TtlExpired {
            elapsed: Duration::from_secs(310),
            ttl: Duration::from_secs(300),
        }
    );
}

#[test]
fn test_cache_metrics_and_hit_rate_recording() {
    let mut tracker = ProviderCacheTracker::new();
    let key = CacheKey::new("thread-metrics", "anthropic");
    let t0 = Instant::now();

    // Request 1: Cold start creation
    tracker.record_usage(&key, t0, 2000, 0, 2000);

    // Request 2: Pure hit (no new cache creation)
    let t1 = t0 + Duration::from_secs(30);
    tracker.record_usage(&key, t1, 2200, 2000, 0);

    // Request 3: Hit with incremental cache creation
    let t2 = t0 + Duration::from_secs(60);
    tracker.record_usage(&key, t2, 2500, 2200, 300);

    // Request 4: Expired miss with recreation
    let t3 = t0 + Duration::from_secs(400);
    tracker.record_usage(&key, t3, 2600, 0, 2600);

    let metrics = tracker.metrics(&key).expect("metrics should exist");
    assert_eq!(metrics.total_requests, 4);
    assert_eq!(metrics.cache_hits, 2);
    assert_eq!(metrics.cache_misses, 2);
    assert_eq!(metrics.cache_creations, 3);
    assert_eq!(metrics.total_input_tokens, 9300);
    assert_eq!(metrics.total_cached_tokens, 4200);
    assert_eq!(metrics.total_created_tokens, 4900);

    // Hit rate: 2 / 4 = 0.5
    assert!((metrics.hit_rate() - 0.5).abs() < 1e-6);
    // Token cached ratio: 4200 / 9300 ≈ 0.4516
    assert!((metrics.token_cached_ratio() - (4200.0 / 9300.0)).abs() < 1e-4);
}

#[test]
fn test_multi_thread_and_provider_isolation() {
    let mut tracker = ProviderCacheTracker::new();
    let key_anthropic_1 = CacheKey::new("thread-1", "anthropic");
    let key_anthropic_2 = CacheKey::new("thread-2", "anthropic");
    let key_openai_1 = CacheKey::new("thread-1", "openai");
    let t0 = Instant::now();

    tracker.record_usage(&key_anthropic_1, t0, 2000, 0, 2000);

    let t100 = t0 + Duration::from_secs(100);
    tracker.record_usage(&key_openai_1, t100, 3000, 0, 3000);

    // thread-2 has not made any requests yet -> Cold
    assert_eq!(tracker.get_state(&key_anthropic_2, t100), CacheState::Cold);

    // thread-1 anthropic at t100 -> Hot (elapsed 100s, ttl 300s)
    assert_eq!(tracker.get_state(&key_anthropic_1, t100), CacheState::Hot);

    // thread-1 openai at t100 -> Hot (elapsed 0s, ttl 600s)
    assert_eq!(tracker.get_state(&key_openai_1, t100), CacheState::Hot);

    // At t350: anthropic_1 is expired (350s > 300s), but openai_1 is still Hot (250s < 600s)
    let t350 = t0 + Duration::from_secs(350);
    assert_eq!(tracker.get_state(&key_anthropic_1, t350), CacheState::Cold);
    assert_eq!(tracker.get_state(&key_openai_1, t350), CacheState::Hot);
}

#[test]
fn test_safe_input_queue_prefix_preservation() {
    let mut queue = SafeInputQueue::new();

    // Enqueue first input
    let res1 = queue.enqueue_user_input("First turn message");
    assert!(res1.is_ok());
    assert_eq!(queue.len(), 1);

    // Enqueue second input
    let res2 = queue.enqueue_user_input("Second turn message");
    assert!(res2.is_ok());
    assert_eq!(queue.len(), 2);

    // Prefix validation: history items must remain strictly sequential/append-only
    let items = queue.peek_all();
    assert_eq!(items[0].text(), "First turn message");
    assert_eq!(items[1].text(), "Second turn message");
}

#[test]
fn test_safe_input_queue_coalescing() {
    let mut queue = SafeInputQueue::new();

    queue.enqueue_user_input("Line 1 of input").unwrap();
    queue.enqueue_user_input("Line 2 of input").unwrap();
    queue.enqueue_user_input("Line 3 of input").unwrap();

    let coalesced = queue.coalesce_to_single_turn();
    assert!(coalesced.is_some());
    let payload = coalesced.unwrap();
    assert_eq!(payload.item_count(), 3);
    assert_eq!(
        payload.combined_text(),
        "Line 1 of input\nLine 2 of input\nLine 3 of input"
    );

    // Queue is drained after coalescing
    assert!(queue.is_empty());
}

#[test]
fn test_safe_input_queue_urgent_flush_near_expiry() {
    let mut tracker = ProviderCacheTracker::new();
    let key = CacheKey::new("thread-flush", "anthropic");
    let t0 = Instant::now();

    // Initial write
    tracker.record_usage(&key, t0, 2000, 0, 2000);

    let mut queue = SafeInputQueue::new();
    queue
        .enqueue_user_input("Queued input while tool was running")
        .unwrap();

    // At t0 + 60s: Hot -> Not urgent (can wait/debounce)
    let t60 = t0 + Duration::from_secs(60);
    assert!(!queue.should_flush_urgently(&key, t60, &tracker));

    // At t0 + 275s: NearExpiry -> Urgent! Flush immediately to prevent 5m Anthropic TTL expiration
    let t275 = t0 + Duration::from_secs(275);
    assert!(queue.should_flush_urgently(&key, t275, &tracker));

    // At t0 + 310s: Cold/Expired -> Not urgent because cache is already expired (cold start)
    let t310 = t0 + Duration::from_secs(310);
    assert!(!queue.should_flush_urgently(&key, t310, &tracker));

    // Empty queue is never urgent
    let empty_queue = SafeInputQueue::new();
    assert!(!empty_queue.should_flush_urgently(&key, t275, &tracker));
}

#[test]
fn test_cache_impact_preview() {
    let mut tracker = ProviderCacheTracker::new();
    let key = CacheKey::new("thread-preview", "anthropic");
    let t0 = Instant::now();

    // Before any request: Cold start preview
    let preview0 = tracker.preview_cache_impact(&key, t0, 2000);
    assert_eq!(preview0.expected_state, CacheState::Cold);
    assert!(preview0.will_create_cache);
    assert!(!preview0.will_hit_cache);

    // Record request
    tracker.record_usage(&key, t0, 2000, 0, 2000);

    // While hot at t60: Cache hit preview
    let t60 = t0 + Duration::from_secs(60);
    let preview60 = tracker.preview_cache_impact(&key, t60, 2200);
    assert_eq!(preview60.expected_state, CacheState::Hot);
    assert!(preview60.will_hit_cache);
    assert!(!preview60.will_create_cache);

    // While near expiry at t280: Warning preview
    let t280 = t0 + Duration::from_secs(280);
    let preview280 = tracker.preview_cache_impact(&key, t280, 2200);
    assert_eq!(preview280.expected_state, CacheState::NearExpiry);
    assert!(preview280.will_hit_cache);
    assert!(preview280.is_near_expiry);

    // After expiration at t320: Cache miss / recreation preview
    let t320 = t0 + Duration::from_secs(320);
    let preview320 = tracker.preview_cache_impact(&key, t320, 2200);
    assert_eq!(preview320.expected_state, CacheState::Cold);
    assert!(preview320.will_create_cache);
    assert!(!preview320.will_hit_cache);
}
