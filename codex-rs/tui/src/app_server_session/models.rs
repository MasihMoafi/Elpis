//! Fetch picker models without blocking the event loop and keep new-thread defaults in sync.
//!
//! Elpis: every model picker lists the engine's catalog live (`model/list` with `refresh`), so a
//! model added while Elpis runs appears the next time a picker opens, and a failed fetch is
//! reported instead of an old list.

use super::AppServerSession;
use super::model_preset_from_api_model;
use crate::app_event::AppEvent;
use crate::app_event_sender::AppEventSender;
use crate::chatwidget::ElpisProviderEvent;
use crate::elpis_app_event::ElpisAppEvent;
use codex_app_server_client::AppServerRequestHandle;
use codex_app_server_protocol::ClientRequest;
use codex_app_server_protocol::ModelListParams;
use codex_app_server_protocol::ModelListResponse;
use codex_app_server_protocol::RequestId;
use codex_protocol::openai_models::ModelPreset;
use uuid::Uuid;

/// The live catalog of `model_provider` (default: the provider the app server started with).
async fn list_live_models(
    request_handle: AppServerRequestHandle,
    request_id: Uuid,
    model_provider: Option<String>,
) -> Result<Vec<ModelPreset>, String> {
    request_handle
        .request_typed::<ModelListResponse>(ClientRequest::ModelList {
            request_id: RequestId::String(format!("model-list-{request_id}")),
            params: ModelListParams {
                cursor: None,
                limit: None,
                include_hidden: Some(true),
                refresh: Some(true),
                model_provider,
            },
        })
        .await
        .map(|response| {
            response
                .data
                .into_iter()
                .map(model_preset_from_api_model)
                .collect()
        })
        .map_err(|err| err.to_string())
}

impl AppServerSession {
    pub(crate) fn set_available_models(&mut self, models: Vec<ModelPreset>) {
        if let Some(default) = models
            .iter()
            .find(|model| model.is_default)
            .or(models.first())
        {
            self.default_model = Some(default.model.clone());
        }
        self.available_models = models;
    }

    pub(crate) fn fetch_models(&self, request_id: Uuid, app_event_tx: AppEventSender) {
        let request_handle = self.request_handle();
        tokio::spawn(async move {
            let result =
                list_live_models(request_handle, request_id, /*model_provider*/ None).await;
            app_event_tx.send(AppEvent::ModelsLoaded { request_id, result });
        });
    }

    /// Lists `provider_id`'s models for the provider-aware picker. `model_provider` is `None` when
    /// the app server's own provider lists them (it is `provider_id`, or a bridged subscription).
    pub(crate) fn fetch_provider_models(
        &self,
        provider_id: String,
        model_provider: Option<String>,
        request_id: Uuid,
        app_event_tx: AppEventSender,
    ) {
        let request_handle = self.request_handle();
        tokio::spawn(async move {
            let result = list_live_models(request_handle, request_id, model_provider).await;
            app_event_tx.send(AppEvent::Elpis(ElpisAppEvent::Provider(
                ElpisProviderEvent::ModelsLoaded {
                    provider_id,
                    request_id,
                    result,
                },
            )));
        });
    }
}
