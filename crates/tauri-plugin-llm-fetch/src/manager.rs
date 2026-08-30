use crate::{
    config::{canonicalize_patterns, HostPolicy, ValidatedConfig},
    contracts::*,
    errors::{ErrorCode, ErrorResponse},
    network::policy,
    platform, security,
    session::Session,
    webview::Worker,
};
use std::{
    collections::{hash_map::Entry, HashMap},
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc, RwLock as SyncRwLock,
    },
    time::{Duration, Instant},
};
use tauri::{AppHandle, Runtime};
use tokio::sync::{Mutex, OwnedMutexGuard, OwnedSemaphorePermit, RwLock, Semaphore};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

mod validation;
#[cfg(test)]
use validation::normalize_source_text;
use validation::{truncate_to_characters, valid_request_id, validate_fetch_options};

struct ActiveRequest {
    token: CancellationToken,
    stage: SyncRwLock<FetchStage>,
    session_id: SyncRwLock<Option<Uuid>>,
}

impl ActiveRequest {
    fn new(token: CancellationToken) -> Self {
        Self {
            token,
            stage: SyncRwLock::new(FetchStage::Queued),
            session_id: SyncRwLock::new(None),
        }
    }

    fn set_stage(&self, stage: FetchStage) {
        if let Ok(mut current) = self.stage.write() {
            *current = stage;
        }
    }

    fn stage(&self) -> FetchStage {
        self.stage
            .read()
            .map_or(FetchStage::CleaningUp, |stage| stage.clone())
    }

    fn set_session_id(&self, session_id: Uuid) {
        if let Ok(mut current) = self.session_id.write() {
            *current = Some(session_id);
        }
    }

    fn session_id(&self) -> Option<Uuid> {
        self.session_id.read().map_or(None, |value| *value)
    }
}

pub struct LlmFetchManager<R: Runtime> {
    pub app: AppHandle<R>,
    pub config: Arc<ValidatedConfig>,
    sessions: RwLock<HashMap<Uuid, Arc<Session<R>>>>,
    requests: RwLock<HashMap<String, Arc<ActiveRequest>>>,
    session_slots: Arc<Semaphore>,
    operation_slots: Arc<Semaphore>,
    queued_requests: Arc<AtomicUsize>,
    shutting_down: AtomicBool,
    root_cancel: CancellationToken,
    create_guard: Mutex<()>,
}

impl<R: Runtime> LlmFetchManager<R> {
    pub fn new(app: AppHandle<R>, config: Arc<ValidatedConfig>) -> Self {
        Self {
            app,
            session_slots: Arc::new(Semaphore::new(config.raw.max_sessions)),
            operation_slots: Arc::new(Semaphore::new(config.raw.max_sessions)),
            queued_requests: Arc::new(AtomicUsize::new(0)),
            config,
            sessions: RwLock::new(HashMap::new()),
            requests: RwLock::new(HashMap::new()),
            shutting_down: AtomicBool::new(false),
            root_cancel: CancellationToken::new(),
            create_guard: Mutex::new(()),
        }
    }

    pub fn start_idle_reaper(self: &Arc<Self>) {
        let manager = Arc::downgrade(self);
        let stop = self.root_cancel.clone();
        let interval = Duration::from_millis(
            (self.config.raw.session_idle_timeout_ms / 2).clamp(1_000, 30_000),
        );
        tauri::async_runtime::spawn(async move {
            loop {
                tokio::select! {
                    _ = stop.cancelled() => break,
                    _ = tokio::time::sleep(interval) => {
                        let Some(manager) = manager.upgrade() else { break; };
                        manager.reap_idle_sessions().await;
                    }
                }
            }
        });
    }

    pub async fn status(&self) -> PluginStatus {
        let sessions = self.sessions.read().await;
        PluginStatus {
            version: env!("CARGO_PKG_VERSION").into(),
            platform: std::env::consts::OS.into(),
            support: platform::platform_support(),
            active_sessions: sessions.len(),
            active_requests: self.requests.read().await.len(),
            queued_requests: self.queued_requests.load(Ordering::Acquire),
            shutting_down: self.shutting_down.load(Ordering::Relaxed),
        }
    }

    pub async fn create_session(
        &self,
        request: CreateSessionRequest,
    ) -> Result<SessionInfo, ErrorResponse> {
        self.ensure_supported()?;
        if request.allowed_hosts.is_empty() || request.allowed_hosts.iter().any(|host| host == "*")
        {
            return Err(ErrorResponse::new(ErrorCode::InvalidInput));
        }
        let allowed_hosts = canonicalize_patterns(&request.allowed_hosts)?;
        let policy = self.config.global_hosts.scoped(&allowed_hosts)?;
        let idle_timeout_ms = request
            .idle_timeout_ms
            .unwrap_or(self.config.raw.session_idle_timeout_ms);
        if !(1_000..=self.config.raw.session_idle_timeout_ms).contains(&idle_timeout_ms) {
            return Err(ErrorResponse::new(ErrorCode::InvalidInput));
        }
        let (session_id, _) = self
            .build_session(policy, Duration::from_millis(idle_timeout_ms), true, None)
            .await?;
        Ok(SessionInfo {
            session_id,
            created_at: now(),
            idle_timeout_ms,
            allowed_hosts,
        })
    }

    pub async fn fetch(
        &self,
        mut request: FetchRequest,
    ) -> Result<RetrievedDocument, ErrorResponse> {
        self.ensure_supported()?;
        if !valid_request_id(&request.request_id) {
            return Err(ErrorResponse::new(ErrorCode::InvalidInput));
        }
        validate_fetch_options(&mut request, &self.config)
            .map_err(|error| error.request_id(&request.request_id))?;
        let context = Arc::new(ActiveRequest::new(self.root_cancel.child_token()));
        let mut active = self.requests.write().await;
        match active.entry(request.request_id.clone()) {
            Entry::Occupied(_) => {
                return Err(
                    ErrorResponse::new(ErrorCode::DuplicateRequest).request_id(&request.request_id)
                );
            }
            Entry::Vacant(entry) => {
                entry.insert(context.clone());
            }
        }
        drop(active);

        let timeout = Duration::from_millis(
            request
                .timeout_ms
                .unwrap_or(self.config.raw.request_timeout_ms),
        );
        let result = match tokio::time::timeout(timeout, self.fetch_inner(&request, &context)).await
        {
            Ok(result) => result,
            Err(_) => {
                context.token.cancel();
                Err(ErrorResponse::new(ErrorCode::Timeout).request_id(&request.request_id))
            }
        };
        let result = result.map_err(|mut error| {
            if error.request_id.is_none() {
                error.request_id = Some(request.request_id.clone());
            }
            if error.session_id.is_none() {
                error.session_id = request.session_id;
            }
            if error.stage.is_none() {
                error.stage = Some(context.stage());
            }
            error
        });

        let fatal = result.as_ref().is_err_and(|error| {
            matches!(
                &error.code,
                ErrorCode::Cancelled
                    | ErrorCode::Timeout
                    | ErrorCode::UnsafeUrl
                    | ErrorCode::DnsFailure
                    | ErrorCode::ProxyFailure
                    | ErrorCode::NavigationFailed
                    | ErrorCode::NavigationUnstable
                    | ErrorCode::EvaluationFailed
                    | ErrorCode::ResponseTooLarge
                    | ErrorCode::WebviewUnavailable
            )
        });
        if request.session_id.is_none() || fatal {
            if let Some(session_id) = context.session_id() {
                self.invalidate_session(session_id).await;
            }
        }
        self.requests.write().await.remove(&request.request_id);
        result
    }

    pub async fn cancel(&self, request: CancelRequest) -> CancelResult {
        if !valid_request_id(&request.request_id) {
            return CancelResult { accepted: false };
        }
        let requests = self.requests.read().await;
        CancelResult {
            accepted: requests.get(&request.request_id).is_some_and(|request| {
                request.token.cancel();
                true
            }),
        }
    }

    pub async fn close_session(
        &self,
        request: CloseSessionRequest,
    ) -> Result<CloseSessionResult, ErrorResponse> {
        for active in self.requests.read().await.values() {
            if active.session_id() == Some(request.session_id) {
                active.token.cancel();
            }
        }
        let session = self
            .sessions
            .write()
            .await
            .remove(&request.session_id)
            .ok_or_else(|| {
                ErrorResponse::new(ErrorCode::SessionNotFound).session_id(request.session_id)
            })?;
        session.close();
        Ok(CloseSessionResult {
            session_id: request.session_id,
            closed: true,
        })
    }

    pub async fn shutdown(&self) {
        self.shutting_down.store(true, Ordering::Release);
        self.root_cancel.cancel();
        for request in self.requests.read().await.values() {
            request.token.cancel();
        }
        for (_, session) in self.sessions.write().await.drain() {
            session.close();
        }
    }

    pub fn shutdown_now(&self) {
        self.shutting_down.store(true, Ordering::Release);
        self.root_cancel.cancel();
        if let Ok(requests) = self.requests.try_read() {
            for request in requests.values() {
                request.token.cancel();
            }
        }
        if let Ok(mut sessions) = self.sessions.try_write() {
            for (_, session) in sessions.drain() {
                session.close();
            }
        }
    }

    async fn fetch_inner(
        &self,
        request: &FetchRequest,
        context: &Arc<ActiveRequest>,
    ) -> Result<RetrievedDocument, ErrorResponse> {
        if let Some(session_id) = request.session_id {
            context.set_session_id(session_id);
            let session = self
                .sessions
                .read()
                .await
                .get(&session_id)
                .cloned()
                .ok_or_else(|| {
                    ErrorResponse::new(ErrorCode::SessionNotFound).session_id(session_id)
                })?;
            return self
                .fetch_with_session(request, context, session, Some(session_id))
                .await;
        }

        context.set_stage(FetchStage::CreatingSession);
        let policy = self.config.global_hosts.clone();
        self.validate_target(&request.url, &policy, &context.token)
            .await?;
        let (internal_id, session) = self
            .build_session(
                policy,
                self.config.session_idle_timeout,
                false,
                Some(&context.token),
            )
            .await?;
        context.set_session_id(internal_id);
        let result = self
            .fetch_with_session(request, context, session, None)
            .await;
        context.set_stage(FetchStage::CleaningUp);
        self.invalidate_session(internal_id).await;
        result
    }

    async fn fetch_with_session(
        &self,
        request: &FetchRequest,
        context: &Arc<ActiveRequest>,
        session: Arc<Session<R>>,
        response_session_id: Option<Uuid>,
    ) -> Result<RetrievedDocument, ErrorResponse> {
        let _use = session.begin()?;
        let url = self
            .validate_target(&request.url, &session.policy, &context.token)
            .await?;
        let (queued_ms, _operation, _execution) = self.acquire_execution(&session, context).await?;
        let maximum = request
            .max_characters
            .unwrap_or(self.config.raw.max_characters);
        let settle_quiet_ms = request
            .settle_quiet_ms
            .unwrap_or(self.config.raw.settle_quiet_ms);
        let mut worker_result = session
            .worker
            .retrieve(
                url,
                &self.config,
                Duration::from_millis(settle_quiet_ms),
                context.token.clone(),
                |stage| context.set_stage(stage),
            )
            .await?;
        worker_result.queued_ms = worker_result.queued_ms.saturating_add(queued_ms);

        let mut snapshot = worker_result.snapshot;
        let mut reasons = worker_result.truncation_reasons;
        if worker_result.network_budget_exhausted
            && !reasons.contains(&TruncationReason::NetworkBudgetExhausted)
        {
            reasons.push(TruncationReason::NetworkBudgetExhausted);
        }
        if worker_result.network_received_bytes > self.config.raw.network.max_request_received_bytes
            || worker_result.network_sent_bytes > self.config.raw.network.max_request_sent_bytes
        {
            return Err(ErrorResponse::new(ErrorCode::ResponseTooLarge));
        }
        let final_url = self
            .validate_target(&snapshot.final_url, &session.policy, &context.token)
            .await?;
        snapshot.final_url = final_url.into();
        let media_type = snapshot
            .content_type
            .split(';')
            .next()
            .unwrap_or_default()
            .trim()
            .to_ascii_lowercase();
        if !matches!(
            media_type.as_str(),
            "text/html" | "application/xhtml+xml" | "text/plain"
        ) {
            return Err(ErrorResponse::new(ErrorCode::UnsupportedContentType));
        }
        if truncate_to_characters(&mut snapshot.text, maximum) {
            snapshot.truncated = true;
            if !reasons.contains(&TruncationReason::TextLimit) {
                reasons.push(TruncationReason::TextLimit);
            }
        }
        if snapshot.text.trim().is_empty() {
            return Err(ErrorResponse::new(ErrorCode::ContentInsufficient));
        }
        let has_challenge_marker = snapshot.has_captcha_or_challenge_frame
            || snapshot.has_recaptcha_marker
            || snapshot.has_hcaptcha_marker
            || (snapshot.has_form && snapshot.has_input);
        if is_bot_challenge(&snapshot.title, &snapshot.text, has_challenge_marker) {
            return Err(ErrorResponse::new(ErrorCode::BotChallenge));
        }

        context.set_stage(FetchStage::Guarding);
        let guard_started = Instant::now();
        let requested_use = request.requested_use.clone().unwrap_or_default();
        let mut guard_visible = String::new();
        push_guard_text(&mut guard_visible, &snapshot.title);
        push_guard_text(&mut guard_visible, &snapshot.text);
        push_guard_text(&mut guard_visible, &request.url);
        push_guard_text(&mut guard_visible, &snapshot.final_url);
        if let Some(source) = &request.source {
            push_guard_text(&mut guard_visible, &source.provider);
            push_guard_text(&mut guard_visible, &source.query);
            if let Some(snippet) = &source.snippet {
                push_guard_text(&mut guard_visible, snippet);
            }
        }
        let inspection = security::inspect(
            &guard_visible,
            &snapshot.security_segments,
            self.config.raw.max_security_characters,
            requested_use,
            !reasons.is_empty(),
        );
        for reason in inspection.truncation_reasons {
            if !reasons.contains(&reason) {
                reasons.push(reason);
            }
        }
        snapshot.truncated = !reasons.is_empty();
        let mut security = inspection.result;
        if response_session_id.is_some() {
            security.limitations.push(
                "A reusable session retains in-process cookies and storage for its allowed origins."
                    .into(),
            );
        }
        if self.config.raw.allow_http {
            security
                .limitations
                .push("Plain HTTP does not provide transport confidentiality.".into());
        }
        for reason in &reasons {
            let limitation = truncation_limitation(reason);
            if !security
                .limitations
                .iter()
                .any(|current| current == limitation)
            {
                security.limitations.push(limitation.into());
            }
        }
        let fetched_at = now();
        let source = request.source.as_ref().map(|input| SourceMetadata {
            kind: SourceKind::SearchResult,
            trust: TrustLevel::Untrusted,
            url: request.url.clone(),
            final_url: snapshot.final_url.clone(),
            provider: input.provider.clone(),
            query: input.query.clone(),
            rank: input.rank,
            snippet: input.snippet.clone(),
            retrieved_at: fetched_at.clone(),
        });
        let excerpt = Some(snapshot.text.chars().take(240).collect());
        Ok(RetrievedDocument {
            request_id: request.request_id.clone(),
            session_id: response_session_id,
            url: request.url.clone(),
            final_url: snapshot.final_url,
            title: snapshot.title,
            character_count: snapshot.text.chars().count(),
            text: snapshot.text,
            excerpt,
            content_type: snapshot.content_type,
            language: snapshot.language,
            fetched_at,
            fetch_method: FetchMethod::TauriWebview,
            truncated: snapshot.truncated,
            source,
            security,
            diagnostics: FetchDiagnostics {
                queued_ms: worker_result.queued_ms,
                navigation_ms: worker_result.navigation_ms,
                settle_ms: worker_result.settle_ms,
                extraction_ms: worker_result.extraction_ms,
                guard_ms: guard_started.elapsed().as_millis() as u64,
                navigation_count: worker_result.navigation_count,
                dom_nodes_visited: snapshot.node_count,
                network_received_bytes: worker_result.network_received_bytes,
                network_sent_bytes: worker_result.network_sent_bytes,
                network_budget_exhausted: worker_result.network_budget_exhausted,
                truncation_reasons: reasons,
            },
        })
    }

    async fn validate_target(
        &self,
        raw: &str,
        host_policy: &HostPolicy,
        cancel: &CancellationToken,
    ) -> Result<url::Url, ErrorResponse> {
        let url = policy::validate_url(raw, self.config.raw.allow_http, host_policy)?;
        tokio::select! {
            biased;
            result = policy::resolve_public(
                &url,
                Duration::from_millis(self.config.raw.network.dns_timeout_ms),
            ) => {
                result?;
            },
            _ = cancel.cancelled() => {
                return Err(ErrorResponse::new(ErrorCode::Cancelled));
            }
        }
        Ok(url)
    }

    async fn build_session(
        &self,
        policy: HostPolicy,
        idle_timeout: Duration,
        exposed: bool,
        cancel: Option<&CancellationToken>,
    ) -> Result<(Uuid, Arc<Session<R>>), ErrorResponse> {
        if self.shutting_down.load(Ordering::Acquire) {
            return Err(ErrorResponse::new(ErrorCode::Cancelled));
        }
        let permit = self
            .session_slots
            .clone()
            .try_acquire_owned()
            .map_err(|_| ErrorResponse::new(ErrorCode::SessionCapacity))?;
        let _guard = if let Some(cancel) = cancel {
            tokio::select! {
                guard = self.create_guard.lock() => guard,
                _ = cancel.cancelled() => {
                    return Err(ErrorResponse::new(ErrorCode::Cancelled));
                }
            }
        } else {
            self.create_guard.lock().await
        };
        if self.shutting_down.load(Ordering::Acquire) {
            return Err(ErrorResponse::new(ErrorCode::Cancelled));
        }
        let creation = tokio::time::timeout(
            self.config.session_create_timeout,
            Worker::create(&self.app, &self.config, policy.clone()),
        );
        tokio::pin!(creation);
        let created = if let Some(cancel) = cancel {
            tokio::select! {
                result = &mut creation => result,
                _ = cancel.cancelled() => {
                    return Err(ErrorResponse::new(ErrorCode::Cancelled));
                }
            }
        } else {
            creation.await
        };
        let worker = created.map_err(|_| ErrorResponse::new(ErrorCode::Timeout))??;
        let session_id = Uuid::new_v4();
        let session = Session::new(policy, worker, exposed, idle_timeout, permit);
        let mut sessions = self.sessions.write().await;
        if self.shutting_down.load(Ordering::Acquire) {
            session.close();
            return Err(ErrorResponse::new(ErrorCode::Cancelled));
        }
        sessions.insert(session_id, session.clone());
        Ok((session_id, session))
    }

    async fn acquire_execution(
        &self,
        session: &Arc<Session<R>>,
        context: &Arc<ActiveRequest>,
    ) -> Result<(u64, OwnedMutexGuard<()>, OwnedSemaphorePermit), ErrorResponse> {
        let queued_at = Instant::now();
        let mut reservation = None;
        let operation = match session.operation.clone().try_lock_owned() {
            Ok(operation) => operation,
            Err(_) => {
                reservation = Some(QueueReservation::reserve(
                    self.queued_requests.clone(),
                    self.config.raw.max_queue_depth,
                )?);
                tokio::select! {
                    operation = session.operation.clone().lock_owned() => operation,
                    _ = context.token.cancelled() => {
                        return Err(ErrorResponse::new(ErrorCode::Cancelled));
                    }
                }
            }
        };
        let execution = match self.operation_slots.clone().try_acquire_owned() {
            Ok(execution) => execution,
            Err(_) => {
                if reservation.is_none() {
                    reservation = Some(QueueReservation::reserve(
                        self.queued_requests.clone(),
                        self.config.raw.max_queue_depth,
                    )?);
                }
                tokio::select! {
                    execution = self.operation_slots.clone().acquire_owned() => {
                        execution.map_err(|_| ErrorResponse::new(ErrorCode::Cancelled))?
                    },
                    _ = context.token.cancelled() => {
                        return Err(ErrorResponse::new(ErrorCode::Cancelled));
                    }
                }
            }
        };
        let queued_ms = if reservation.is_some() {
            queued_at.elapsed().as_millis() as u64
        } else {
            0
        };
        drop(reservation);
        Ok((queued_ms, operation, execution))
    }

    async fn invalidate_session(&self, session_id: Uuid) {
        for active in self.requests.read().await.values() {
            if active.session_id() == Some(session_id) {
                active.token.cancel();
            }
        }
        if let Some(session) = self.sessions.write().await.remove(&session_id) {
            session.close();
        }
    }

    async fn reap_idle_sessions(&self) {
        let candidates = self
            .sessions
            .read()
            .await
            .iter()
            .filter_map(|(id, session)| session.is_idle_expired().then_some(*id))
            .collect::<Vec<_>>();
        let mut expired = Vec::new();
        let mut sessions = self.sessions.write().await;
        for session_id in candidates {
            if sessions
                .get(&session_id)
                .is_some_and(|session| session.is_idle_expired())
            {
                if let Some(session) = sessions.remove(&session_id) {
                    expired.push(session);
                }
            }
        }
        drop(sessions);
        for session in expired {
            session.close();
        }
    }

    fn ensure_supported(&self) -> Result<(), ErrorResponse> {
        if self.shutting_down.load(Ordering::Acquire) {
            return Err(ErrorResponse::new(ErrorCode::Cancelled));
        }
        match platform::platform_support().overall {
            SupportLevel::Unsupported => Err(ErrorResponse::new(ErrorCode::UnsupportedPlatform)),
            SupportLevel::BestEffort if self.config.raw.require_reliable_background => {
                Err(ErrorResponse::new(ErrorCode::BackgroundUnsupported))
            }
            _ => Ok(()),
        }
    }
}

fn push_guard_text(output: &mut String, value: &str) {
    if value.is_empty() {
        return;
    }
    if !output.is_empty() {
        output.push('\n');
    }
    output.push_str(value);
}

fn is_bot_challenge(title: &str, text: &str, has_challenge_marker: bool) -> bool {
    if text.chars().count() > 5_000 {
        return false;
    }
    let title = title.trim().to_ascii_lowercase();
    let text = text.to_ascii_lowercase();
    (has_challenge_marker && (text.contains("captcha") || text.contains("verify you are human")))
        || ((title == "just a moment..." || title.starts_with("attention required"))
            && (text.contains("checking your browser") || text.contains("security check")))
        || text.contains("unusual traffic from your computer network")
}

fn truncation_limitation(reason: &TruncationReason) -> &'static str {
    match reason {
        TruncationReason::DomNodeLimit => "DOM node limit reached.",
        TruncationReason::DomDepthLimit => "DOM depth limit reached.",
        TruncationReason::CandidateLimit => "Content candidate limit reached.",
        TruncationReason::TextLimit => "Returned text limit reached.",
        TruncationReason::SegmentLimit => "Security segment limit reached.",
        TruncationReason::SegmentTextLimit => "Per-segment text limit reached.",
        TruncationReason::DomSettleTimeout => "DOM settling timed out.",
        TruncationReason::NetworkBudgetExhausted => "Network byte budget was exhausted.",
        TruncationReason::SecurityCharacterLimit => "Security character inspection limit reached.",
        TruncationReason::FindingLimit => "Security finding limit reached.",
    }
}

pub struct LlmFetch<R: Runtime>(pub Arc<LlmFetchManager<R>>);
impl<R: Runtime> Clone for LlmFetch<R> {
    fn clone(&self) -> Self {
        Self(self.0.clone())
    }
}

struct QueueReservation {
    counter: Arc<AtomicUsize>,
}

impl QueueReservation {
    fn reserve(counter: Arc<AtomicUsize>, maximum: usize) -> Result<Self, ErrorResponse> {
        if maximum == 0 {
            return Err(ErrorResponse::new(ErrorCode::QueueFull));
        }
        counter
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |current| {
                (current < maximum).then_some(current + 1)
            })
            .map_err(|_| ErrorResponse::new(ErrorCode::QueueFull))?;
        Ok(Self { counter })
    }
}

impl Drop for QueueReservation {
    fn drop(&mut self) {
        self.counter.fetch_sub(1, Ordering::AcqRel);
    }
}

#[cfg(test)]
mod tests;
