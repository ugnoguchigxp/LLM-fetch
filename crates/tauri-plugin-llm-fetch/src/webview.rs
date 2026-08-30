use crate::{
    config::{HostPolicy, ValidatedConfig},
    contracts::{FetchStage, SecurityFindingLocation, TruncationReason},
    errors::{ErrorCode, ErrorResponse},
    network::proxy::LoopbackProxy,
};
use serde::Deserialize;
use std::{
    collections::HashSet,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc, Mutex as SyncMutex,
    },
    time::Duration,
};
use tauri::{
    utils::config::BackgroundThrottlingPolicy,
    webview::{NewWindowResponse, PageLoadEvent},
    AppHandle, Runtime, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
};
use tokio::{
    sync::{broadcast, oneshot, Mutex},
    time::{sleep, timeout, Instant},
};
use tokio_util::sync::CancellationToken;
use url::Url;
use uuid::Uuid;

mod types;
use types::{ExtractOptions, HardeningProbe, MutationState, PendingWindow};
pub(crate) use types::{PageSnapshot, RawSecuritySegment};

const INTERNAL_URL: &str = "llm-fetch-internal://localhost/worker";

pub struct Worker<R: Runtime> {
    window: WebviewWindow<R>,
    proxy: LoopbackProxy,
    serial: Mutex<()>,
    waiting: AtomicUsize,
    load_events: broadcast::Sender<LoadEvent>,
    navigation_gate: Arc<NavigationGate>,
}

struct NavigationGate {
    policy: HostPolicy,
    allow_http: bool,
    state: SyncMutex<NavigationState>,
    violations: broadcast::Sender<ErrorCode>,
}

#[derive(Default)]
struct NavigationState {
    active: bool,
    resetting: bool,
    accepted: u32,
}

struct NavigationUse(Arc<NavigationGate>);

impl NavigationGate {
    fn new(policy: HostPolicy, allow_http: bool) -> Arc<Self> {
        let (violations, _) = broadcast::channel(16);
        Arc::new(Self {
            policy,
            allow_http,
            state: SyncMutex::new(NavigationState::default()),
            violations,
        })
    }

    fn begin(self: &Arc<Self>) -> Result<NavigationUse, ErrorResponse> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| ErrorResponse::new(ErrorCode::WebviewUnavailable))?;
        if state.active {
            return Err(ErrorResponse::new(ErrorCode::WebviewUnavailable));
        }
        *state = NavigationState {
            active: true,
            resetting: false,
            accepted: 0,
        };
        Ok(NavigationUse(self.clone()))
    }

    fn prepare_reset(&self, expected_generation: u32) -> Result<(), ErrorResponse> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| ErrorResponse::new(ErrorCode::WebviewUnavailable))?;
        if !state.active {
            return Err(ErrorResponse::new(ErrorCode::WebviewUnavailable));
        }
        if state.accepted != expected_generation {
            return Err(ErrorResponse::new(ErrorCode::NavigationUnstable));
        }
        state.resetting = true;
        Ok(())
    }

    fn generation(&self) -> Result<u32, ErrorResponse> {
        self.state
            .lock()
            .map(|state| state.accepted)
            .map_err(|_| ErrorResponse::new(ErrorCode::WebviewUnavailable))
    }

    fn accept(&self, url: &Url) -> bool {
        let Ok(mut state) = self.state.lock() else {
            let _ = self.violations.send(ErrorCode::WebviewUnavailable);
            return false;
        };
        if url.as_str() == INTERNAL_URL {
            if !state.active || state.resetting {
                return true;
            }
            let _ = self.violations.send(ErrorCode::NavigationUnstable);
            return false;
        }
        if !state.active {
            return false;
        }
        if state.resetting {
            let _ = self.violations.send(ErrorCode::NavigationUnstable);
            return false;
        }
        if crate::network::policy::validate_url(url.as_str(), self.allow_http, &self.policy)
            .is_err()
        {
            let _ = self.violations.send(ErrorCode::UnsafeUrl);
            return false;
        }
        if state.accepted >= 8 {
            let _ = self.violations.send(ErrorCode::NavigationUnstable);
            return false;
        }
        state.accepted += 1;
        true
    }

    fn finish(&self) {
        if let Ok(mut state) = self.state.lock() {
            *state = NavigationState::default();
        }
    }
}

impl Drop for NavigationUse {
    fn drop(&mut self) {
        self.0.finish();
    }
}

pub struct WorkerResult {
    pub snapshot: PageSnapshot,
    pub queued_ms: u64,
    pub navigation_ms: u64,
    pub settle_ms: u64,
    pub extraction_ms: u64,
    pub navigation_count: u32,
    pub truncation_reasons: Vec<TruncationReason>,
    pub network_received_bytes: u64,
    pub network_sent_bytes: u64,
    pub network_budget_exhausted: bool,
}

#[derive(Clone, Copy, Debug)]
enum LoadPhase {
    Started,
    Finished,
}

#[derive(Clone, Debug)]
struct LoadEvent {
    phase: LoadPhase,
    url: Url,
}

impl<R: Runtime> Worker<R> {
    pub async fn create(
        app: &AppHandle<R>,
        config: &ValidatedConfig,
        policy: HostPolicy,
    ) -> Result<Arc<Self>, ErrorResponse> {
        let proxy = LoopbackProxy::start(policy.clone(), Arc::new(config.clone())).await?;
        let navigation_gate = NavigationGate::new(policy, config.raw.allow_http);
        let navigation_handler = navigation_gate.clone();
        let label = format!("llm-fetch-worker-{}", Uuid::new_v4());
        let (load_events, _) = broadcast::channel(32);
        let mut initial_load_events = load_events.subscribe();
        let event_sender = load_events.clone();
        let initial_url = Url::parse(INTERNAL_URL)
            .map_err(|_| ErrorResponse::new(ErrorCode::WebviewUnavailable))?;
        let window = WebviewWindowBuilder::new(app, label, WebviewUrl::CustomProtocol(initial_url))
            .title("llm-fetch worker")
            .visible(false)
            .focused(false)
            .focusable(false)
            .decorations(false)
            .resizable(false)
            .minimizable(false)
            .maximizable(false)
            .closable(false)
            .always_on_top(false)
            .skip_taskbar(true)
            .incognito(true)
            .devtools(false)
            .zoom_hotkeys_enabled(false)
            .general_autofill_enabled(false)
            .background_throttling(BackgroundThrottlingPolicy::Disabled)
            .proxy_url(proxy.url())
            .initialization_script_for_all_frames(format!(
                "{}\n{}",
                include_str!("../assets/bootstrap.js"),
                include_str!("../assets/extractor.js")
            ))
            .inner_size(config.raw.viewport_width, config.raw.viewport_height)
            .on_navigation(move |url| navigation_handler.accept(url))
            .on_new_window(|_, _| NewWindowResponse::Deny)
            .on_download(|_, _| false)
            .on_page_load(move |_window, payload| {
                let phase = match payload.event() {
                    PageLoadEvent::Started => LoadPhase::Started,
                    PageLoadEvent::Finished => LoadPhase::Finished,
                };
                let _ = event_sender.send(LoadEvent {
                    phase,
                    url: payload.url().clone(),
                });
            })
            .build()
            .map_err(|_| ErrorResponse::new(ErrorCode::WebviewUnavailable))?;
        let mut pending_window = PendingWindow::new(window);
        wait_for_internal_page(&mut initial_load_events, config.eval_timeout).await?;
        let window = pending_window.take()?;
        Ok(Arc::new(Self {
            window,
            proxy,
            serial: Mutex::new(()),
            waiting: AtomicUsize::new(0),
            load_events,
            navigation_gate,
        }))
    }

    pub async fn retrieve<F>(
        &self,
        url: Url,
        config: &ValidatedConfig,
        settle_quiet: Duration,
        cancel: CancellationToken,
        set_stage: F,
    ) -> Result<WorkerResult, ErrorResponse>
    where
        F: Fn(FetchStage),
    {
        let queued_at = Instant::now();
        let waiting = CounterGuard::new(&self.waiting);
        let serial = tokio::select! {
            lock = self.serial.lock() => lock,
            _ = cancel.cancelled() => return Err(ErrorResponse::new(ErrorCode::Cancelled)),
        };
        drop(waiting);
        let queued_ms = queued_at.elapsed().as_millis() as u64;
        let _navigation = self.navigation_gate.begin()?;
        let network_request = self.proxy.begin_request()?;
        let network_cancel = network_request.cancellation_token();
        let mut load_events = self.load_events.subscribe();
        let mut navigation_violations = self.navigation_gate.violations.subscribe();
        let retrieval = tokio::select! {
        biased;
        _ = cancel.cancelled() => Err(ErrorResponse::new(ErrorCode::Cancelled)),
        _ = network_cancel.cancelled() => {
            Err(ErrorResponse::new(if network_request.policy_violated() {
                ErrorCode::UnsafeUrl
            } else if network_request.budget_exhausted() {
                ErrorCode::ResponseTooLarge
            } else {
                ErrorCode::ProxyFailure
            }))
        },
        violation = navigation_violations.recv() => Err(ErrorResponse::new(
            violation.unwrap_or(ErrorCode::WebviewUnavailable)
        )),
        result = async {
            set_stage(FetchStage::Navigating);
            let navigation_started = Instant::now();
            self.window
                .navigate(url)
                .map_err(|_| ErrorResponse::new(ErrorCode::NavigationFailed))?;
            let navigation_count =
                wait_for_main_page(&mut load_events, config.navigation_timeout, &cancel).await?;
            self.wait_for_hardening(config).await?;
            let navigation_ms = navigation_started.elapsed().as_millis() as u64;
            set_stage(FetchStage::WaitingForDom);
            let settle_started = Instant::now();
            let settle_timed_out = self.wait_until_quiet(
                &mut load_events,
                settle_quiet,
                config.settle_timeout,
                config,
                &cancel,
            )
            .await?;
            let settle_ms = settle_started.elapsed().as_millis() as u64;
            self.verify_hardening(config).await?;
            set_stage(FetchStage::Extracting);
            let settled_generation = self.navigation_gate.generation()?;
            let settled_url = self
                .window
                .url()
                .map_err(|_| ErrorResponse::new(ErrorCode::NavigationFailed))?;
            let extraction_started = Instant::now();
            let snapshot = self.extract(config, &cancel).await?;
            let extraction_ms = extraction_started.elapsed().as_millis() as u64;
            let extracted_url = self
                .window
                .url()
                .map_err(|_| ErrorResponse::new(ErrorCode::NavigationFailed))?;
            if self.navigation_gate.generation()? != settled_generation
                || extracted_url != settled_url
                || snapshot.final_url != extracted_url.as_str()
            {
                return Err(ErrorResponse::new(ErrorCode::NavigationUnstable));
            }
            Ok::<_, ErrorResponse>((
                snapshot,
                navigation_ms,
                settle_ms,
                extraction_ms,
                navigation_count,
                settled_generation,
                settle_timed_out,
            ))
        } => result,
        };
        let retrieval = match retrieval {
            Ok(value) => self
                .reset_to_blank(&mut load_events, config, value.5, &cancel)
                .await
                .map(|()| value),
            error => error,
        };
        let late_navigation_error = match navigation_violations.try_recv() {
            Ok(error) => Some(error),
            Err(broadcast::error::TryRecvError::Empty) => None,
            Err(
                broadcast::error::TryRecvError::Lagged(_) | broadcast::error::TryRecvError::Closed,
            ) => Some(ErrorCode::WebviewUnavailable),
        };
        let network = network_request.finish().await;
        drop(serial);
        if let Some(error) = late_navigation_error {
            return Err(ErrorResponse::new(error));
        }
        if network.policy_violated {
            return Err(ErrorResponse::new(ErrorCode::UnsafeUrl));
        }
        if network.exhausted_count > 0 {
            return Err(ErrorResponse::new(ErrorCode::ResponseTooLarge));
        }
        if cancel.is_cancelled() {
            return Err(ErrorResponse::new(ErrorCode::Cancelled));
        }
        let (
            snapshot,
            navigation_ms,
            settle_ms,
            extraction_ms,
            navigation_count,
            _,
            settle_timed_out,
        ) = retrieval?;
        let mut truncation_reasons = snapshot.truncation_reasons.clone();
        if settle_timed_out {
            truncation_reasons.push(TruncationReason::DomSettleTimeout);
        }
        Ok(WorkerResult {
            snapshot,
            queued_ms,
            navigation_ms,
            settle_ms,
            extraction_ms,
            navigation_count,
            truncation_reasons,
            network_received_bytes: network.received,
            network_sent_bytes: network.sent,
            network_budget_exhausted: network.exhausted_count > 0,
        })
    }

    async fn reset_to_blank(
        &self,
        events: &mut broadcast::Receiver<LoadEvent>,
        config: &ValidatedConfig,
        expected_generation: u32,
        cancel: &CancellationToken,
    ) -> Result<(), ErrorResponse> {
        self.navigation_gate.prepare_reset(expected_generation)?;
        self.window
            .navigate(
                Url::parse(INTERNAL_URL)
                    .map_err(|_| ErrorResponse::new(ErrorCode::WebviewUnavailable))?,
            )
            .map_err(|_| ErrorResponse::new(ErrorCode::WebviewUnavailable))?;
        let deadline = Instant::now() + config.eval_timeout;
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err(ErrorResponse::new(ErrorCode::WebviewUnavailable));
            }
            match tokio::select! {
                received = timeout(remaining, events.recv()) => received,
                _ = cancel.cancelled() => {
                    return Err(ErrorResponse::new(ErrorCode::Cancelled));
                }
            } {
                Ok(Ok(event))
                    if event.url.as_str() == INTERNAL_URL
                        && matches!(event.phase, LoadPhase::Finished) =>
                {
                    return Ok(());
                }
                Ok(Ok(_)) | Ok(Err(broadcast::error::RecvError::Lagged(_))) => {}
                Ok(Err(broadcast::error::RecvError::Closed)) | Err(_) => {
                    return Err(ErrorResponse::new(ErrorCode::WebviewUnavailable));
                }
            }
        }
    }

    async fn extract(
        &self,
        config: &ValidatedConfig,
        cancel: &CancellationToken,
    ) -> Result<PageSnapshot, ErrorResponse> {
        let options = ExtractOptions {
            max_characters: config.raw.max_characters,
            max_dom_nodes: config.raw.max_dom_nodes,
            max_dom_depth: config.raw.max_dom_depth,
            max_candidates: config.raw.max_candidates,
            max_segments: config.raw.max_segments,
            max_segment_characters: config.raw.max_segment_characters,
            max_payload_bytes: config.raw.max_payload_bytes,
        };
        let serialized = serde_json::to_string(&options)
            .map_err(|_| ErrorResponse::new(ErrorCode::EvaluationFailed))?;
        let script = format!(
            "typeof globalThis.__LLM_FETCH_EXTRACT__ === 'function' ? globalThis.__LLM_FETCH_EXTRACT__({serialized}) : null"
        );
        let snapshot = tokio::select! {
            result = self.eval_json::<PageSnapshot>(&script, config.eval_timeout, config.raw.max_payload_bytes) => result,
            _ = cancel.cancelled() => Err(ErrorResponse::new(ErrorCode::Cancelled)),
        }?;
        let mut seen_reasons = HashSet::new();
        let invalid_reason = snapshot.truncation_reasons.iter().any(|reason| {
            matches!(
                reason,
                TruncationReason::DomSettleTimeout
                    | TruncationReason::NetworkBudgetExhausted
                    | TruncationReason::SecurityCharacterLimit
                    | TruncationReason::FindingLimit
            ) || !seen_reasons.insert(reason)
        });
        if snapshot.node_count > config.raw.max_dom_nodes as u32
            || snapshot.candidate_count > config.raw.max_candidates as u32
            || snapshot.security_segments.len() > config.raw.max_segments
            || snapshot.text.chars().count() > config.raw.max_characters
            || snapshot.final_url.len() > 2_048
            || snapshot.title.chars().count() > 1_000
            || snapshot.content_type.chars().count() > 64
            || snapshot
                .language
                .as_ref()
                .is_some_and(|language| language.chars().count() > 64)
            || snapshot.truncated == snapshot.truncation_reasons.is_empty()
            || invalid_reason
        {
            return Err(ErrorResponse::new(ErrorCode::EvaluationFailed));
        }
        let invalid_segment = snapshot.security_segments.iter().find(|segment| {
            let text_length = segment.text.chars().count();
            matches!(segment.location, SecurityFindingLocation::Visible)
                || text_length > config.raw.max_segment_characters
                || has_disallowed_control(&segment.text)
                || segment.original_length < text_length
                || (segment.truncated && segment.original_length == text_length)
                || (!segment.truncated && segment.original_length != text_length)
        });
        let invalid_string = [
            snapshot.title.as_str(),
            snapshot.text.as_str(),
            snapshot.final_url.as_str(),
            snapshot.content_type.as_str(),
            snapshot.language.as_deref().unwrap_or_default(),
        ]
        .into_iter()
        .any(has_disallowed_control);
        if invalid_segment.is_some() || invalid_string {
            return Err(ErrorResponse::new(ErrorCode::EvaluationFailed));
        }
        Ok(snapshot)
    }

    async fn wait_until_quiet(
        &self,
        events: &mut broadcast::Receiver<LoadEvent>,
        quiet: Duration,
        maximum: Duration,
        config: &ValidatedConfig,
        cancel: &CancellationToken,
    ) -> Result<bool, ErrorResponse> {
        let deadline = Instant::now() + maximum;
        let mut last_activity = Instant::now();
        let mut revision = self.mutation_state(config).await?.revision;
        loop {
            let now = Instant::now();
            if now >= deadline {
                return Ok(true);
            }
            let quiet_elapsed = now.duration_since(last_activity);
            if quiet_elapsed >= quiet {
                return Ok(false);
            }
            let poll = Duration::from_millis(100)
                .min(deadline.saturating_duration_since(now))
                .min(quiet.saturating_sub(quiet_elapsed));
            tokio::select! {
                _ = sleep(poll) => {
                    let current = self.mutation_state(config).await?.revision;
                    if current != revision {
                        revision = current;
                        last_activity = Instant::now();
                    }
                },
                received = events.recv() => match received {
                    Ok(_) | Err(broadcast::error::RecvError::Lagged(_)) => {
                        last_activity = Instant::now();
                    },
                    Err(broadcast::error::RecvError::Closed) => {
                        return Err(ErrorResponse::new(ErrorCode::NavigationFailed));
                    },
                },
                _ = cancel.cancelled() => return Err(ErrorResponse::new(ErrorCode::Cancelled)),
            }
        }
    }

    async fn mutation_state(
        &self,
        config: &ValidatedConfig,
    ) -> Result<MutationState, ErrorResponse> {
        self.eval_json(
            "globalThis.__LLM_FETCH_BOOTSTRAP__?.mutationState?.() ?? null",
            config.eval_timeout.min(Duration::from_millis(500)),
            1_024,
        )
        .await
    }

    async fn verify_hardening(&self, config: &ValidatedConfig) -> Result<(), ErrorResponse> {
        let script = r#"(() => {
          try {
            const blocked = (value, name) => typeof value === 'function' && value.name === `Blocked${name}`;
            const absentOrBlocked = (value, name) => typeof value !== 'function' || blocked(value, name);
            return {
              webSocket: blocked(globalThis.WebSocket, 'WebSocket'),
              webTransport: blocked(globalThis.WebTransport, 'WebTransport'),
              worker: blocked(globalThis.Worker, 'Worker'),
              sharedWorker: blocked(globalThis.SharedWorker, 'SharedWorker'),
              eventSource: blocked(globalThis.EventSource, 'EventSource'),
              rtcPeerConnection: blocked(globalThis.RTCPeerConnection, 'RTCPeerConnection') &&
                blocked(globalThis.webkitRTCPeerConnection, 'webkitRTCPeerConnection'),
              sendBeacon: blocked(globalThis.navigator?.sendBeacon, 'sendBeacon'),
              windowOpen: blocked(globalThis.open, 'window.open'),
              serviceWorker: !globalThis.navigator?.serviceWorker || blocked(globalThis.navigator.serviceWorker.register, 'serviceWorker.register'),
              mediaDevices: !globalThis.navigator?.mediaDevices || (
                absentOrBlocked(globalThis.navigator.mediaDevices.getUserMedia, 'mediaDevices.getUserMedia') &&
                absentOrBlocked(globalThis.navigator.mediaDevices.getDisplayMedia, 'mediaDevices.getDisplayMedia')
              ),
              geolocation: !globalThis.navigator?.geolocation || (
                absentOrBlocked(globalThis.navigator.geolocation.getCurrentPosition, 'geolocation.getCurrentPosition') &&
                absentOrBlocked(globalThis.navigator.geolocation.watchPosition, 'geolocation.watchPosition')
              ),
              clipboard: !globalThis.navigator?.clipboard || (
                absentOrBlocked(globalThis.navigator.clipboard.read, 'clipboard.read') &&
                absentOrBlocked(globalThis.navigator.clipboard.readText, 'clipboard.readText') &&
                absentOrBlocked(globalThis.navigator.clipboard.write, 'clipboard.write') &&
                absentOrBlocked(globalThis.navigator.clipboard.writeText, 'clipboard.writeText')
              ),
              credentials: !globalThis.navigator?.credentials || (
                absentOrBlocked(globalThis.navigator.credentials.create, 'credentials.create') &&
                absentOrBlocked(globalThis.navigator.credentials.get, 'credentials.get') &&
                absentOrBlocked(globalThis.navigator.credentials.store, 'credentials.store') &&
                absentOrBlocked(globalThis.navigator.credentials.preventSilentAccess, 'credentials.preventSilentAccess')
              ),
              filePicker: absentOrBlocked(globalThis.showOpenFilePicker, 'showOpenFilePicker') &&
                absentOrBlocked(globalThis.showSaveFilePicker, 'showSaveFilePicker') &&
                absentOrBlocked(globalThis.showDirectoryPicker, 'showDirectoryPicker'),
              dialogs: blocked(globalThis.alert, 'alert') && blocked(globalThis.confirm, 'confirm') &&
                blocked(globalThis.prompt, 'prompt') && blocked(globalThis.print, 'print'),
              notification: !globalThis.Notification || absentOrBlocked(
                globalThis.Notification.requestPermission, 'Notification.requestPermission'
              ),
              share: absentOrBlocked(globalThis.navigator?.share, 'navigator.share'),
              devices: (!globalThis.navigator?.usb || absentOrBlocked(globalThis.navigator.usb.requestDevice, 'usb.requestDevice')) &&
                (!globalThis.navigator?.serial || absentOrBlocked(globalThis.navigator.serial.requestPort, 'serial.requestPort')) &&
                (!globalThis.navigator?.hid || absentOrBlocked(globalThis.navigator.hid.requestDevice, 'hid.requestDevice')) &&
                (!globalThis.navigator?.bluetooth || absentOrBlocked(globalThis.navigator.bluetooth.requestDevice, 'bluetooth.requestDevice')),
              mutationObserver: globalThis.__LLM_FETCH_BOOTSTRAP__?.mutationState?.().observerActive === true,
              bootstrap: globalThis.__LLM_FETCH_BOOTSTRAP__?.hardeningComplete === true &&
                typeof globalThis.__LLM_FETCH_BOOTSTRAP__?.mutationState === 'function',
              extractor: typeof globalThis.__LLM_FETCH_EXTRACT__ === 'function'
            };
          } catch (_) { return null; }
        })()"#;
        let probe = self
            .eval_json::<HardeningProbe>(script, config.eval_timeout, 2_048)
            .await?;
        if probe.complete() {
            Ok(())
        } else {
            Err(ErrorResponse::new(ErrorCode::EvaluationFailed))
        }
    }

    async fn wait_for_hardening(&self, config: &ValidatedConfig) -> Result<(), ErrorResponse> {
        let deadline = Instant::now() + config.eval_timeout;
        loop {
            if self.verify_hardening(config).await.is_ok() {
                return Ok(());
            }
            if Instant::now() >= deadline {
                return Err(ErrorResponse::new(ErrorCode::EvaluationFailed));
            }
            sleep(Duration::from_millis(25)).await;
        }
    }

    async fn eval_json<T: for<'a> Deserialize<'a>>(
        &self,
        script: &str,
        wait: Duration,
        max_payload_bytes: usize,
    ) -> Result<T, ErrorResponse> {
        let (sender, receiver) = oneshot::channel();
        let sender = std::sync::Mutex::new(Some(sender));
        self.window
            .eval_with_callback(script, move |value| {
                if let Ok(mut sender) = sender.lock() {
                    if let Some(sender) = sender.take() {
                        let _ = sender.send(value);
                    }
                }
            })
            .map_err(|_| ErrorResponse::new(ErrorCode::EvaluationFailed))?;
        let raw = timeout(wait, receiver)
            .await
            .map_err(|_| ErrorResponse::new(ErrorCode::Timeout))?
            .map_err(|_| ErrorResponse::new(ErrorCode::EvaluationFailed))?;
        if raw.len() > max_payload_bytes {
            return Err(ErrorResponse::new(ErrorCode::ResponseTooLarge));
        }
        serde_json::from_str(&raw).map_err(|_| ErrorResponse::new(ErrorCode::EvaluationFailed))
    }

    pub fn close(&self) {
        self.proxy.close();
        let _ = self.window.close();
    }
}

fn has_disallowed_control(value: &str) -> bool {
    value.chars().any(|character| {
        let value = character as u32;
        (value <= 0x1f && !matches!(character, '\t' | '\n' | '\r'))
            || (0x7f..=0x9f).contains(&value)
    })
}

async fn wait_for_main_page(
    events: &mut broadcast::Receiver<LoadEvent>,
    maximum: Duration,
    cancel: &CancellationToken,
) -> Result<u32, ErrorResponse> {
    let deadline = Instant::now() + maximum;
    let mut started = false;
    let mut navigation_count = 0_u32;
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(ErrorResponse::new(ErrorCode::Timeout));
        }
        tokio::select! {
            received = timeout(remaining, events.recv()) => match received {
                Ok(Ok(event)) if matches!(event.url.scheme(), "http" | "https") => match event.phase {
                    LoadPhase::Started => {
                        started = true;
                        navigation_count = navigation_count.saturating_add(1);
                    },
                    LoadPhase::Finished if started => return Ok(navigation_count.max(1)),
                    LoadPhase::Finished => {},
                },
                Ok(Ok(_)) | Ok(Err(broadcast::error::RecvError::Lagged(_))) => {},
                Ok(Err(broadcast::error::RecvError::Closed)) => return Err(ErrorResponse::new(ErrorCode::NavigationFailed)),
                Err(_) => return Err(ErrorResponse::new(ErrorCode::Timeout)),
            },
            _ = cancel.cancelled() => return Err(ErrorResponse::new(ErrorCode::Cancelled)),
        }
    }
}

async fn wait_for_internal_page(
    events: &mut broadcast::Receiver<LoadEvent>,
    maximum: Duration,
) -> Result<(), ErrorResponse> {
    let deadline = Instant::now() + maximum;
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(ErrorResponse::new(ErrorCode::WebviewUnavailable));
        }
        match timeout(remaining, events.recv()).await {
            Ok(Ok(event))
                if event.url.as_str() == INTERNAL_URL
                    && matches!(event.phase, LoadPhase::Finished) =>
            {
                return Ok(());
            }
            Ok(Ok(_)) | Ok(Err(broadcast::error::RecvError::Lagged(_))) => {}
            Ok(Err(broadcast::error::RecvError::Closed)) | Err(_) => {
                return Err(ErrorResponse::new(ErrorCode::WebviewUnavailable));
            }
        }
    }
}

struct CounterGuard<'a>(&'a AtomicUsize);
impl<'a> CounterGuard<'a> {
    fn new(counter: &'a AtomicUsize) -> Self {
        counter.fetch_add(1, Ordering::Relaxed);
        Self(counter)
    }
}
impl Drop for CounterGuard<'_> {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::Relaxed);
    }
}

impl<R: Runtime> Drop for Worker<R> {
    fn drop(&mut self) {
        self.proxy.close();
        let _ = self.window.close();
    }
}

#[cfg(test)]
mod tests;
