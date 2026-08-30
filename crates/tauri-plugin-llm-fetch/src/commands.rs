use crate::{contracts::*, errors::ErrorResponse, manager::LlmFetch};
use tauri::{AppHandle, Manager, Runtime};

fn state<R: Runtime>(app: &AppHandle<R>) -> &LlmFetch<R> {
    app.state::<LlmFetch<R>>().inner()
}
#[tauri::command]
pub async fn status<R: Runtime>(app: AppHandle<R>) -> Result<PluginStatus, ErrorResponse> {
    Ok(state(&app).0.status().await)
}
#[tauri::command]
pub async fn create_session<R: Runtime>(
    app: AppHandle<R>,
    request: CreateSessionRequest,
) -> Result<SessionInfo, ErrorResponse> {
    state(&app).0.create_session(request).await
}
#[tauri::command]
pub async fn fetch<R: Runtime>(
    app: AppHandle<R>,
    request: FetchRequest,
) -> Result<RetrievedDocument, ErrorResponse> {
    state(&app).0.fetch(request).await
}
#[tauri::command]
pub async fn cancel<R: Runtime>(
    app: AppHandle<R>,
    request: CancelRequest,
) -> Result<CancelResult, ErrorResponse> {
    Ok(state(&app).0.cancel(request).await)
}
#[tauri::command]
pub async fn close_session<R: Runtime>(
    app: AppHandle<R>,
    request: CloseSessionRequest,
) -> Result<CloseSessionResult, ErrorResponse> {
    state(&app).0.close_session(request).await
}
