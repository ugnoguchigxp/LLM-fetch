use crate::manager::LlmFetch;
use tauri::{AppHandle, Manager, RunEvent, Runtime};

pub fn on_event<R: Runtime>(app: &AppHandle<R>, event: &RunEvent) {
    if matches!(event, RunEvent::Exit) {
        if let Some(fetch) = app.try_state::<LlmFetch<R>>() {
            fetch.0.shutdown_now();
        }
    }
}
pub fn on_drop<R: Runtime>(app: AppHandle<R>) {
    if let Some(fetch) = app.try_state::<LlmFetch<R>>() {
        fetch.0.shutdown_now();
    }
}
