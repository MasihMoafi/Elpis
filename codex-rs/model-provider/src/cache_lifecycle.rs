// Modified from OpenAI Codex (Apache-2.0) by the Elpis project.
//! Provider Prompt-Cache Lifecycle Awareness.
//!
//! Provides TTL tracking (such as Anthropic's 5-minute ephemeral cache window),
//! cache-state classification (Hot, NearExpiry, Cold), cache-miss detection,
//! token usage metrics, and safe input queueing that preserves prompt prefix stability
//! without busting the provider prompt cache.

use std::collections::HashMap;
use std::time::{Duration, Instant};

/// Configuration and timing rules for a provider's prompt cache.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProviderCachePolicy {
    /// Identifier for the provider (e.g. "anthropic", "openai").
    pub provider_name: String,
    /// Total duration that an unrefreshed prompt cache entry remains valid.
    pub ttl: Duration,
    /// Warning window before expiration (e.g. 30 seconds before 5m TTL expires).
    pub near_expiry_window: Duration,
    /// Minimum prompt token threshold required by the provider to activate caching.
    pub min_tokens: u64,
}

impl ProviderCachePolicy {
    /// Default policy for Anthropic Claude (5-minute / 300s ephemeral cache TTL, 30s near-expiry margin).
    pub fn anthropic() -> Self {
        Self {
            provider_name: "anthropic".to_string(),
            ttl: Duration::from_secs(300),
            near_expiry_window: Duration::from_secs(30),
            min_tokens: 1024,
        }
    }

    /// Default policy for OpenAI Responses API (10-minute / 600s cache TTL, 60s near-expiry margin).
    pub fn openai() -> Self {
        Self {
            provider_name: "openai".to_string(),
            ttl: Duration::from_secs(600),
            near_expiry_window: Duration::from_secs(60),
            min_tokens: 1024,
        }
    }

    /// Creates a custom provider cache policy.
    pub fn custom(
        provider_name: impl Into<String>,
        ttl: Duration,
        near_expiry_window: Duration,
        min_tokens: u64,
    ) -> Self {
        Self {
            provider_name: provider_name.into(),
            ttl,
            near_expiry_window,
            min_tokens,
        }
    }

    /// Looks up or defaults a policy for a given provider ID.
    pub fn for_provider(provider_id: &str) -> Self {
        match provider_id.to_ascii_lowercase().as_str() {
            "anthropic" | "claude" => Self::anthropic(),
            _ => Self::openai(),
        }
    }

    /// Point in elapsed duration from last request when cache transitions into `NearExpiry`.
    pub fn expiry_threshold(&self) -> Duration {
        self.ttl.saturating_sub(self.near_expiry_window)
    }
}

/// Lifecycle state of a provider prompt cache entry.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum CacheState {
    /// Cache does not exist or has expired past TTL.
    Cold,
    /// Cache is active, fresh, and well within TTL.
    Hot,
    /// Cache is active but nearing expiration (within warning window).
    NearExpiry,
}

impl CacheState {
    #[inline]
    pub fn is_cold(&self) -> bool {
        matches!(self, Self::Cold)
    }

    #[inline]
    pub fn is_hot(&self) -> bool {
        matches!(self, Self::Hot)
    }

    #[inline]
    pub fn is_near_expiry(&self) -> bool {
        matches!(self, Self::NearExpiry)
    }
}

/// Compound identifier for tracking prompt cache state.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct CacheKey {
    pub thread_id: String,
    pub provider_id: String,
}

impl CacheKey {
    pub fn new(thread_id: impl Into<String>, provider_id: impl Into<String>) -> Self {
        Self {
            thread_id: thread_id.into(),
            provider_id: provider_id.into(),
        }
    }
}

/// Categorization of prompt cache hit or miss outcomes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CacheMissReason {
    /// Cache hit occurred (cached tokens > 0).
    Hit,
    /// First request on this thread/session (no prior cache entry).
    ColdStart,
    /// Cache expired because elapsed time exceeded provider TTL.
    TtlExpired { elapsed: Duration, ttl: Duration },
    /// Prompt size was under the provider's minimum caching token threshold.
    BelowTokenThreshold {
        prompt_tokens: u64,
        min_required: u64,
    },
    /// Content before a cache breakpoint diverged or was invalidated.
    PrefixInvalidated,
    /// Unspecified miss reason.
    Unknown,
}

/// Cumulative cache usage metrics for a thread/provider.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CacheMetrics {
    pub total_requests: u64,
    pub cache_hits: u64,
    pub cache_misses: u64,
    pub cache_creations: u64,
    pub total_input_tokens: u64,
    pub total_cached_tokens: u64,
    pub total_created_tokens: u64,
    pub last_request_time: Option<Instant>,
    pub last_response_cached_tokens: u64,
    pub last_response_created_tokens: u64,
}

impl CacheMetrics {
    /// Fraction of requests that resulted in a cache hit (0.0 to 1.0).
    pub fn hit_rate(&self) -> f64 {
        if self.total_requests == 0 {
            0.0
        } else {
            self.cache_hits as f64 / self.total_requests as f64
        }
    }

    /// Ratio of total cached tokens read to total input tokens billed.
    pub fn token_cached_ratio(&self) -> f64 {
        if self.total_input_tokens == 0 {
            0.0
        } else {
            self.total_cached_tokens as f64 / self.total_input_tokens as f64
        }
    }
}

/// Preview of predicted cache behavior for an upcoming request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CacheImpactPreview {
    pub expected_state: CacheState,
    pub will_hit_cache: bool,
    pub will_create_cache: bool,
    pub is_near_expiry: bool,
    pub estimated_remaining_ttl: Option<Duration>,
}

/// Central tracker for provider prompt-cache lifecycles.
#[derive(Debug, Clone)]
pub struct ProviderCacheTracker {
    policies: HashMap<String, ProviderCachePolicy>,
    metrics: HashMap<CacheKey, CacheMetrics>,
    last_requests: HashMap<CacheKey, Instant>,
}

impl Default for ProviderCacheTracker {
    fn default() -> Self {
        Self::new()
    }
}

impl ProviderCacheTracker {
    /// Creates a new tracker initialized with default provider policies.
    pub fn new() -> Self {
        let mut policies = HashMap::new();
        policies.insert("anthropic".to_string(), ProviderCachePolicy::anthropic());
        policies.insert("claude".to_string(), ProviderCachePolicy::anthropic());
        policies.insert("openai".to_string(), ProviderCachePolicy::openai());
        Self {
            policies,
            metrics: HashMap::new(),
            last_requests: HashMap::new(),
        }
    }

    /// Registers a custom policy for a provider.
    pub fn set_policy(&mut self, provider_id: impl Into<String>, policy: ProviderCachePolicy) {
        self.policies.insert(provider_id.into(), policy);
    }

    /// Retrieves the policy for a provider, falling back to default lookup.
    pub fn policy_for(&self, provider_id: &str) -> ProviderCachePolicy {
        self.policies
            .get(provider_id)
            .cloned()
            .unwrap_or_else(|| ProviderCachePolicy::for_provider(provider_id))
    }

    /// Returns the current cache lifecycle state for a given key.
    pub fn get_state(&self, key: &CacheKey, now: Instant) -> CacheState {
        let Some(&last_time) = self.last_requests.get(key) else {
            return CacheState::Cold;
        };
        let policy = self.policy_for(&key.provider_id);
        let elapsed = now.saturating_duration_since(last_time);

        if elapsed >= policy.ttl {
            CacheState::Cold
        } else if elapsed >= policy.expiry_threshold() {
            CacheState::NearExpiry
        } else {
            CacheState::Hot
        }
    }

    /// Returns the remaining TTL duration before cache expiration, if active.
    pub fn remaining_ttl(&self, key: &CacheKey, now: Instant) -> Option<Duration> {
        let &last_time = self.last_requests.get(key)?;
        let policy = self.policy_for(&key.provider_id);
        let elapsed = now.saturating_duration_since(last_time);

        if elapsed >= policy.ttl {
            Some(Duration::ZERO)
        } else {
            Some(policy.ttl.saturating_sub(elapsed))
        }
    }

    /// Returns the duration elapsed since the last request for the given key.
    pub fn elapsed_since_last_request(&self, key: &CacheKey, now: Instant) -> Option<Duration> {
        self.last_requests
            .get(key)
            .map(|&last| now.saturating_duration_since(last))
    }

    /// Analyzes request parameters to diagnose whether a hit occurred or why a miss happened.
    pub fn detect_miss_reason(
        &self,
        key: &CacheKey,
        now: Instant,
        prompt_tokens: u64,
        cached_tokens: u64,
    ) -> CacheMissReason {
        if cached_tokens > 0 {
            return CacheMissReason::Hit;
        }

        let policy = self.policy_for(&key.provider_id);
        if prompt_tokens < policy.min_tokens {
            return CacheMissReason::BelowTokenThreshold {
                prompt_tokens,
                min_required: policy.min_tokens,
            };
        }

        let Some(&last_time) = self.last_requests.get(key) else {
            return CacheMissReason::ColdStart;
        };

        let elapsed = now.saturating_duration_since(last_time);
        if elapsed >= policy.ttl {
            CacheMissReason::TtlExpired {
                elapsed,
                ttl: policy.ttl,
            }
        } else {
            CacheMissReason::PrefixInvalidated
        }
    }

    /// Records token usage from an inference response, refreshes the last request timestamp,
    /// and updates cumulative metrics.
    pub fn record_usage(
        &mut self,
        key: &CacheKey,
        now: Instant,
        input_tokens: u64,
        cached_tokens: u64,
        created_tokens: u64,
    ) -> CacheMissReason {
        let miss_reason = self.detect_miss_reason(key, now, input_tokens, cached_tokens);

        // Update last request timestamp (refreshes TTL)
        self.last_requests.insert(key.clone(), now);

        let entry = self.metrics.entry(key.clone()).or_default();
        entry.total_requests += 1;
        entry.total_input_tokens += input_tokens;
        entry.total_cached_tokens += cached_tokens;
        entry.total_created_tokens += created_tokens;
        entry.last_request_time = Some(now);
        entry.last_response_cached_tokens = cached_tokens;
        entry.last_response_created_tokens = created_tokens;

        if cached_tokens > 0 {
            entry.cache_hits += 1;
        } else {
            entry.cache_misses += 1;
        }

        if created_tokens > 0 {
            entry.cache_creations += 1;
        }

        miss_reason
    }

    /// Returns a reference to metrics for a given key.
    pub fn metrics(&self, key: &CacheKey) -> Option<&CacheMetrics> {
        self.metrics.get(key)
    }

    /// Returns an iterator over all tracked cache metrics.
    pub fn all_metrics(&self) -> impl Iterator<Item = (&CacheKey, &CacheMetrics)> {
        self.metrics.iter()
    }

    /// Computes a preview of expected cache impact for an upcoming request.
    pub fn preview_cache_impact(
        &self,
        key: &CacheKey,
        now: Instant,
        prompt_tokens: u64,
    ) -> CacheImpactPreview {
        let state = self.get_state(key, now);
        let policy = self.policy_for(&key.provider_id);
        let remaining = self.remaining_ttl(key, now);

        let meets_threshold = prompt_tokens >= policy.min_tokens;
        let will_hit_cache = state != CacheState::Cold && meets_threshold;
        let will_create_cache = (state == CacheState::Cold || !will_hit_cache) && meets_threshold;

        CacheImpactPreview {
            expected_state: state,
            will_hit_cache,
            will_create_cache,
            is_near_expiry: state == CacheState::NearExpiry,
            estimated_remaining_ttl: remaining,
        }
    }
}

/// A queued user input message.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QueuedUserInput {
    pub text: String,
    pub queued_at: Instant,
    pub client_id: Option<String>,
}

impl QueuedUserInput {
    pub fn new(text: impl Into<String>) -> Self {
        Self {
            text: text.into(),
            queued_at: Instant::now(),
            client_id: None,
        }
    }

    pub fn text(&self) -> &str {
        &self.text
    }
}

/// Consolidated payload produced from coalescing multiple queued inputs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QueuedTurnPayload {
    pub items: Vec<QueuedUserInput>,
}

impl QueuedTurnPayload {
    pub fn item_count(&self) -> usize {
        self.items.len()
    }

    pub fn combined_text(&self) -> String {
        self.items
            .iter()
            .map(|item| item.text.as_str())
            .collect::<Vec<_>>()
            .join("\n")
    }
}

/// Safe input queue that prevents prompt cache thrashing and prefix invalidation.
#[derive(Debug, Clone, Default)]
pub struct SafeInputQueue {
    items: Vec<QueuedUserInput>,
}

impl SafeInputQueue {
    pub fn new() -> Self {
        Self { items: Vec::new() }
    }

    /// Enqueues a user input preserving append-only prefix invariants.
    pub fn enqueue_user_input(&mut self, text: impl Into<String>) -> Result<(), String> {
        let text = text.into();
        if text.trim().is_empty() {
            return Err("cannot enqueue empty input".to_string());
        }
        self.items.push(QueuedUserInput::new(text));
        Ok(())
    }

    pub fn len(&self) -> usize {
        self.items.len()
    }

    pub fn is_empty(&self) -> bool {
        self.items.is_empty()
    }

    pub fn peek_all(&self) -> &[QueuedUserInput] {
        &self.items
    }

    /// Coalesces queued inputs into a single coherent prompt turn payload, draining the queue.
    pub fn coalesce_to_single_turn(&mut self) -> Option<QueuedTurnPayload> {
        if self.items.is_empty() {
            None
        } else {
            let items = std::mem::take(&mut self.items);
            Some(QueuedTurnPayload { items })
        }
    }

    /// Determines if queued inputs should be flushed urgently because the provider cache
    /// is nearing expiration (e.g. within 30s of 5-minute Anthropic TTL expiration).
    pub fn should_flush_urgently(
        &self,
        key: &CacheKey,
        now: Instant,
        tracker: &ProviderCacheTracker,
    ) -> bool {
        if self.is_empty() {
            return false;
        }
        tracker.get_state(key, now) == CacheState::NearExpiry
    }
}

#[cfg(test)]
#[path = "cache_lifecycle_tests.rs"]
mod tests;
