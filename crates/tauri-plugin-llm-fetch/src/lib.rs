mod commands;
mod config;
mod contracts;
mod errors;
mod lifecycle;
mod manager;
mod network;
mod platform;
mod security;
mod security_normalize;
mod session;
mod webview;

pub use config::{Config, ValidatedConfig};
pub use contracts::*;
pub use errors::{ErrorCode, ErrorResponse};
pub use manager::{LlmFetch, LlmFetchManager};
use std::sync::Arc;
use tauri::{
    plugin::{Builder as PluginBuilder, TauriPlugin},
    AppHandle, Manager, Runtime,
};

#[derive(Default)]
pub struct Builder {
    config_override: Option<Config>,
}
impl Builder {
    pub fn config(mut self, config: Config) -> Self {
        self.config_override = Some(config);
        self
    }
    pub fn build<R: Runtime>(self) -> TauriPlugin<R, Option<Config>> {
        let override_config = self.config_override;
        PluginBuilder::<R, Option<Config>>::new("llm-fetch")
            .register_uri_scheme_protocol("llm-fetch-internal", |_context, request| {
                let valid = request.method() == http::Method::GET
                    && request.uri().host() == Some("localhost")
                    && request.uri().path() == "/worker"
                    && request.uri().query().is_none();
                http::Response::builder()
                    .status(if valid { 200 } else { 404 })
                    .header(http::header::CONTENT_TYPE, "text/html; charset=utf-8")
                    .header(http::header::CACHE_CONTROL, "no-store")
                    .header("x-content-type-options", "nosniff")
                    .header(
                        http::header::CONTENT_SECURITY_POLICY,
                        "default-src 'none'; base-uri 'none'; form-action 'none'",
                    )
                    .body(if valid {
                        b"<!doctype html><meta charset=utf-8><title>llm-fetch worker</title>"
                            .to_vec()
                    } else {
                        Vec::new()
                    })
                    .expect("static internal response is valid")
            })
            .setup(move |app, api| {
                let config = override_config
                    .clone()
                    .or_else(|| api.config().clone())
                    .unwrap_or_default();
                setup(app, config)
            })
            .invoke_handler(tauri::generate_handler![
                commands::status,
                commands::create_session,
                commands::fetch,
                commands::cancel,
                commands::close_session
            ])
            .on_event(lifecycle::on_event)
            .on_drop(lifecycle::on_drop)
            .build()
    }
}
pub fn init<R: Runtime>() -> TauriPlugin<R, Option<Config>> {
    Builder::default().build()
}

fn setup<R: Runtime>(app: &AppHandle<R>, config: Config) -> Result<(), Box<dyn std::error::Error>> {
    let config = config.validate().map_err(|error| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            format!("invalid llm-fetch config: {}", error.message),
        )
    })?;
    let manager = Arc::new(LlmFetchManager::new(app.clone(), config));
    if !app.manage(LlmFetch(manager.clone())) {
        return Err(std::io::Error::new(
            std::io::ErrorKind::AlreadyExists,
            "llm-fetch managed state is already registered",
        )
        .into());
    }
    manager.start_idle_reaper();
    Ok(())
}

pub trait LlmFetchExt<R: Runtime> {
    fn llm_fetch(&self) -> &LlmFetch<R>;
}
impl<R: Runtime, T: Manager<R>> LlmFetchExt<R> for T {
    fn llm_fetch(&self) -> &LlmFetch<R> {
        self.state::<LlmFetch<R>>().inner()
    }
}
