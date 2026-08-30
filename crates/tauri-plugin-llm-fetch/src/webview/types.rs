use crate::{
    contracts::{SecurityFindingLocation, TruncationReason},
    errors::{ErrorCode, ErrorResponse},
};
use serde::{Deserialize, Serialize};
use tauri::{Runtime, WebviewWindow};

pub(super) struct PendingWindow<R: Runtime>(Option<WebviewWindow<R>>);

impl<R: Runtime> PendingWindow<R> {
    pub(super) fn new(window: WebviewWindow<R>) -> Self {
        Self(Some(window))
    }

    pub(super) fn take(&mut self) -> Result<WebviewWindow<R>, ErrorResponse> {
        self.0
            .take()
            .ok_or_else(|| ErrorResponse::new(ErrorCode::WebviewUnavailable))
    }
}

impl<R: Runtime> Drop for PendingWindow<R> {
    fn drop(&mut self) {
        if let Some(window) = self.0.take() {
            let _ = window.close();
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PageSnapshot {
    pub(crate) title: String,
    pub(crate) text: String,
    #[serde(rename = "finalUrl")]
    pub(crate) final_url: String,
    #[serde(rename = "nodeCount")]
    pub(crate) node_count: u32,
    pub(crate) candidate_count: u32,
    #[serde(rename = "contentType")]
    pub(crate) content_type: String,
    pub(crate) language: Option<String>,
    pub(crate) truncated: bool,
    #[serde(rename = "truncationReasons")]
    pub(crate) truncation_reasons: Vec<TruncationReason>,
    #[serde(rename = "securitySegments")]
    pub(crate) security_segments: Vec<RawSecuritySegment>,
    pub(crate) has_captcha_or_challenge_frame: bool,
    pub(crate) has_recaptcha_marker: bool,
    pub(crate) has_hcaptcha_marker: bool,
    pub(crate) has_form: bool,
    pub(crate) has_input: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RawSecuritySegment {
    pub(crate) location: SecurityFindingLocation,
    pub(crate) text: String,
    pub(crate) truncated: bool,
    pub(crate) original_length: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ExtractOptions {
    pub(super) max_characters: usize,
    pub(super) max_dom_nodes: usize,
    pub(super) max_dom_depth: usize,
    pub(super) max_candidates: usize,
    pub(super) max_segments: usize,
    pub(super) max_segment_characters: usize,
    pub(super) max_payload_bytes: usize,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct MutationState {
    pub(super) revision: u64,
    #[serde(rename = "lastMutation")]
    pub(super) _last_mutation: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct HardeningProbe {
    web_socket: bool,
    web_transport: bool,
    worker: bool,
    shared_worker: bool,
    event_source: bool,
    rtc_peer_connection: bool,
    send_beacon: bool,
    window_open: bool,
    service_worker: bool,
    media_devices: bool,
    geolocation: bool,
    clipboard: bool,
    credentials: bool,
    file_picker: bool,
    dialogs: bool,
    notification: bool,
    share: bool,
    devices: bool,
    mutation_observer: bool,
    bootstrap: bool,
    extractor: bool,
}

impl HardeningProbe {
    pub(super) fn complete(&self) -> bool {
        self.web_socket
            && self.web_transport
            && self.worker
            && self.shared_worker
            && self.event_source
            && self.rtc_peer_connection
            && self.send_beacon
            && self.window_open
            && self.service_worker
            && self.media_devices
            && self.geolocation
            && self.clipboard
            && self.credentials
            && self.file_picker
            && self.dialogs
            && self.notification
            && self.share
            && self.devices
            && self.mutation_observer
            && self.bootstrap
            && self.extractor
    }
}
