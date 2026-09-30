//! Elpis: a provider that serves its own catalog lists exactly its models, with no OpenAI login.

use super::*;
use codex_http_client::OutboundProxyPolicy;
use codex_login::CodexAuth;
use pretty_assertions::assert_eq;
use std::sync::atomic::AtomicUsize;

const FACTORY: HttpClientFactory = HttpClientFactory::new(OutboundProxyPolicy::ReqwestDefault);

#[derive(Debug)]
struct VendorEndpoint {
    serves_own_catalog: bool,
    reachable: bool,
    models: Vec<ModelInfo>,
    fetch_count: AtomicUsize,
}

impl VendorEndpoint {
    fn new(serves_own_catalog: bool) -> Arc<Self> {
        let model: ModelInfo = serde_json::from_value(serde_json::json!({
            "slug": "claude-sonnet-4-6",
            "display_name": "Claude Sonnet 4.6",
            "description": "≈200k context",
            "supported_reasoning_levels": [],
            "shell_type": "shell_command",
            "visibility": "list",
            "supported_in_api": true,
            "priority": 0,
            "availability_nux": null,
            "upgrade": null,
            "model_messages": {"instructions_template": "base instructions"},
            "support_verbosity": false,
            "default_verbosity": null,
            "apply_patch_tool_type": "freeform",
            "truncation_policy": {"mode": "bytes", "limit": 10_000},
            "context_window": 200_000,
            "experimental_supported_tools": [],
        }))
        .expect("valid model");
        Arc::new(Self {
            serves_own_catalog,
            reachable: true,
            models: vec![model],
            fetch_count: AtomicUsize::new(0),
        })
    }
}

impl ModelsEndpointClient for VendorEndpoint {
    fn identity(&self) -> Option<String> {
        Some("elpis-gateway-fixture".to_string())
    }

    fn has_command_auth(&self) -> bool {
        false
    }

    fn uses_codex_backend(&self) -> ModelsEndpointFuture<'_, bool> {
        Box::pin(async { false })
    }

    fn serves_own_catalog(&self) -> bool {
        self.serves_own_catalog
    }

    fn list_models<'a>(
        &'a self,
        _client_version: &'a str,
        _http_client_factory: HttpClientFactory,
    ) -> ModelsEndpointFuture<'a, CoreResult<ModelsEndpointResponse>> {
        Box::pin(async move {
            self.fetch_count.fetch_add(1, Ordering::SeqCst);
            if !self.reachable {
                return Err(codex_protocol::error::CodexErr::RequestTimeout);
            }
            Ok(ModelsEndpointResponse {
                models: self.models.clone(),
                etag: None,
                identity: "elpis-gateway-fixture".to_string(),
            })
        })
    }
}

#[tokio::test]
async fn an_own_catalog_is_fetched_without_login_and_is_the_whole_list() {
    for auth_manager in [
        None,
        Some(AuthManager::from_auth_for_testing(CodexAuth::from_api_key(
            "openai-api-key",
        ))),
    ] {
        let endpoint = VendorEndpoint::new(/*serves_own_catalog*/ true);
        let manager = OpenAiModelsManager::new_without_cache(endpoint.clone(), auth_manager);

        let catalog = manager
            .raw_model_catalog(RefreshStrategy::OnlineIfUncached, FACTORY)
            .await;

        assert_eq!(catalog.models, endpoint.models);
        assert_eq!(endpoint.fetch_count.load(Ordering::SeqCst), 1);
    }
}

#[tokio::test]
async fn without_an_own_catalog_nothing_is_fetched_and_the_bundled_list_stays() {
    let endpoint = VendorEndpoint::new(/*serves_own_catalog*/ false);
    let manager = OpenAiModelsManager::new_without_cache(endpoint.clone(), /*auth_manager*/ None);

    let catalog = manager
        .raw_model_catalog(RefreshStrategy::OnlineIfUncached, FACTORY)
        .await;

    assert_eq!(catalog.models, load_remote_models_from_file().expect("bundled"));
    assert_eq!(endpoint.fetch_count.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn an_unreachable_own_catalog_lists_nothing_rather_than_openai_models() {
    let endpoint = Arc::new(VendorEndpoint {
        reachable: false,
        ..Arc::into_inner(VendorEndpoint::new(/*serves_own_catalog*/ true)).expect("sole owner")
    });
    let manager = OpenAiModelsManager::new_without_cache(endpoint.clone(), /*auth_manager*/ None);

    let catalog = manager
        .raw_model_catalog(RefreshStrategy::OnlineIfUncached, FACTORY)
        .await;

    assert_eq!(catalog.models, Vec::new());
    assert_eq!(endpoint.fetch_count.load(Ordering::SeqCst), 1);
}
