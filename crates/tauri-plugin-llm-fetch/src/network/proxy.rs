use crate::{
    config::{HostPolicy, ValidatedConfig},
    errors::{ErrorCode, ErrorResponse},
    network::policy,
};
use bytes::Bytes;
use http::{header::HeaderName, Method, Request, Response, StatusCode};
use http_body_util::{BodyExt, Empty, Full};
use hyper::{
    body::Incoming, client::conn::http1 as client_http1, server::conn::http1 as server_http1,
    service::service_fn,
};
use hyper_util::rt::TokioIo;
use std::{
    convert::Infallible,
    future::Future,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex, RwLock, Weak,
    },
    time::{Duration, Instant},
};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    sync::Semaphore,
    task::JoinHandle,
};
use tokio_util::sync::CancellationToken;
use url::Url;

/// A loopback-only proxy owned by one hidden WebView. Network access is off
/// between retrievals. Each retrieval activates a generation with independent
/// cancellation, connection tracking, and aggregate byte budgets.
pub struct LoopbackProxy {
    url: Url,
    root_cancel: CancellationToken,
    state: Arc<ProxyState>,
    config: Arc<ValidatedConfig>,
}

#[derive(Clone, Copy, Debug, Default)]
pub struct NetworkSnapshot {
    pub sent: u64,
    pub received: u64,
    pub exhausted_count: u64,
    pub policy_violated: bool,
}

struct ProxyState {
    active: RwLock<Option<Arc<RequestGeneration>>>,
    next_generation: AtomicU64,
    closed: AtomicBool,
    root_tasks: Mutex<TrackedTasks>,
}

struct RequestGeneration {
    id: u64,
    cancel: CancellationToken,
    sent: AtomicU64,
    received: AtomicU64,
    sent_remaining: AtomicU64,
    received_remaining: AtomicU64,
    exhausted_count: AtomicU64,
    policy_violation: AtomicBool,
    tasks: Mutex<TrackedTasks>,
}

#[derive(Default)]
struct TrackedTasks {
    accepting: bool,
    handles: Vec<JoinHandle<()>>,
}

pub struct ProxyRequest {
    generation: Option<Arc<RequestGeneration>>,
    state: Weak<ProxyState>,
}

impl LoopbackProxy {
    pub async fn start(
        policy: HostPolicy,
        config: Arc<ValidatedConfig>,
    ) -> Result<Self, ErrorResponse> {
        let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
            .await
            .map_err(|_| ErrorResponse::new(ErrorCode::ProxyFailure))?;
        let port = listener
            .local_addr()
            .map_err(|_| ErrorResponse::new(ErrorCode::ProxyFailure))?
            .port();
        let root_cancel = CancellationToken::new();
        let stop = root_cancel.clone();
        let connection_slots = Arc::new(Semaphore::new(config.raw.network.max_connections));
        let client_slots = Arc::new(Semaphore::new(config.raw.network.max_connections));
        let state = Arc::new(ProxyState {
            active: RwLock::new(None),
            next_generation: AtomicU64::new(1),
            closed: AtomicBool::new(false),
            root_tasks: Mutex::new(TrackedTasks {
                accepting: true,
                handles: Vec::new(),
            }),
        });
        let service_state = state.clone();
        let service_config = config.clone();
        let accept_task = tokio::spawn(async move {
            loop {
                tokio::select! {
                    _ = stop.cancelled() => break,
                    accepted = listener.accept() => match accepted {
                        Ok((stream, _)) => {
                            let Ok(client_permit) = client_slots.clone().try_acquire_owned() else {
                                continue;
                            };
                            let policy = policy.clone();
                            let config = service_config.clone();
                            let state = service_state.clone();
                            let task_state = service_state.clone();
                            let slots = connection_slots.clone();
                            let connection_task = tokio::spawn(async move {
                                let _client_permit = client_permit;
                                let service = service_fn(move |request| {
                                    handle(
                                        request,
                                        policy.clone(),
                                        config.clone(),
                                        state.clone(),
                                        slots.clone(),
                                    )
                                });
                                let mut server = server_http1::Builder::new();
                                server.max_headers(100).max_buf_size(64 * 1024);
                                let _ = server
                                    .serve_connection(TokioIo::new(stream), service)
                                    .with_upgrades()
                                    .await;
                            });
                            task_state.track_root_handle(connection_task);
                        }
                        Err(_) => break,
                    }
                }
            }
        });
        state.track_root_handle(accept_task);
        Ok(Self {
            url: Url::parse(&format!("http://127.0.0.1:{port}")).expect("loopback URL is valid"),
            root_cancel,
            state,
            config,
        })
    }

    pub fn url(&self) -> Url {
        self.url.clone()
    }

    pub fn begin_request(&self) -> Result<ProxyRequest, ErrorResponse> {
        if self.state.closed.load(Ordering::Acquire) {
            return Err(ErrorResponse::new(ErrorCode::ProxyFailure));
        }
        let id = self.state.next_generation.fetch_add(1, Ordering::Relaxed);
        let generation = Arc::new(RequestGeneration {
            id,
            cancel: self.root_cancel.child_token(),
            sent: AtomicU64::new(0),
            received: AtomicU64::new(0),
            sent_remaining: AtomicU64::new(self.config.raw.network.max_request_sent_bytes),
            received_remaining: AtomicU64::new(self.config.raw.network.max_request_received_bytes),
            exhausted_count: AtomicU64::new(0),
            policy_violation: AtomicBool::new(false),
            tasks: Mutex::new(TrackedTasks {
                accepting: true,
                handles: Vec::new(),
            }),
        });
        let mut active = self
            .state
            .active
            .write()
            .map_err(|_| ErrorResponse::new(ErrorCode::ProxyFailure))?;
        if active.is_some() {
            return Err(ErrorResponse::new(ErrorCode::ProxyFailure));
        }
        *active = Some(generation.clone());
        Ok(ProxyRequest {
            generation: Some(generation),
            state: Arc::downgrade(&self.state),
        })
    }

    pub fn close(&self) {
        if !self.state.closed.swap(true, Ordering::AcqRel) {
            self.root_cancel.cancel();
            if let Ok(mut active) = self.state.active.write() {
                if let Some(generation) = active.take() {
                    generation.abort();
                }
            }
            self.state.abort_root_tasks();
        }
    }
}

impl ProxyRequest {
    pub fn cancellation_token(&self) -> CancellationToken {
        self.generation
            .as_ref()
            .map_or_else(CancellationToken::new, |generation| {
                generation.cancel.clone()
            })
    }

    pub fn budget_exhausted(&self) -> bool {
        self.generation
            .as_ref()
            .is_some_and(|generation| generation.exhausted_count.load(Ordering::Acquire) > 0)
    }

    pub fn policy_violated(&self) -> bool {
        self.generation
            .as_ref()
            .is_some_and(|generation| generation.policy_violation.load(Ordering::Acquire))
    }

    pub async fn finish(mut self) -> NetworkSnapshot {
        let Some(generation) = self.generation.take() else {
            return NetworkSnapshot::default();
        };
        generation.stop_accepting();
        generation.cancel.cancel();
        clear_generation(&self.state, &generation);
        let deadline = Instant::now() + Duration::from_secs(2);
        for mut handle in generation.take_handles() {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() || tokio::time::timeout(remaining, &mut handle).await.is_err() {
                handle.abort();
                let _ = handle.await;
            }
        }
        generation.snapshot()
    }
}

impl Drop for ProxyRequest {
    fn drop(&mut self) {
        if let Some(generation) = self.generation.take() {
            generation.abort();
            clear_generation(&self.state, &generation);
        }
    }
}

impl RequestGeneration {
    fn track<F>(&self, future: F)
    where
        F: Future<Output = ()> + Send + 'static,
    {
        let Ok(mut tasks) = self.tasks.lock() else {
            return;
        };
        if tasks.accepting {
            tasks.handles.push(tokio::spawn(future));
        }
    }

    fn stop_accepting(&self) {
        if let Ok(mut tasks) = self.tasks.lock() {
            tasks.accepting = false;
        }
    }

    fn take_handles(&self) -> Vec<JoinHandle<()>> {
        self.tasks.lock().map_or_else(
            |_| Vec::new(),
            |mut tasks| std::mem::take(&mut tasks.handles),
        )
    }

    fn abort(&self) {
        self.cancel.cancel();
        self.stop_accepting();
        for handle in self.take_handles() {
            handle.abort();
        }
    }

    fn snapshot(&self) -> NetworkSnapshot {
        NetworkSnapshot {
            sent: self.sent.load(Ordering::Relaxed),
            received: self.received.load(Ordering::Relaxed),
            exhausted_count: self.exhausted_count.load(Ordering::Relaxed),
            policy_violated: self.policy_violation.load(Ordering::Acquire),
        }
    }

    fn exhaust(&self) {
        self.exhausted_count.fetch_add(1, Ordering::Relaxed);
        self.cancel.cancel();
    }

    fn reject_policy(&self) {
        self.policy_violation.store(true, Ordering::Release);
        self.cancel.cancel();
    }
}

impl ProxyState {
    fn track_root_handle(&self, handle: JoinHandle<()>) {
        let Ok(mut tasks) = self.root_tasks.lock() else {
            handle.abort();
            return;
        };
        if tasks.accepting && !self.closed.load(Ordering::Acquire) {
            tasks.handles.retain(|task| !task.is_finished());
            tasks.handles.push(handle);
        } else {
            handle.abort();
        }
    }

    fn abort_root_tasks(&self) {
        if let Ok(mut tasks) = self.root_tasks.lock() {
            tasks.accepting = false;
            for handle in tasks.handles.drain(..) {
                handle.abort();
            }
        }
    }
}

fn clear_generation(state: &Weak<ProxyState>, generation: &Arc<RequestGeneration>) {
    let Some(state) = state.upgrade() else {
        return;
    };
    if let Ok(mut active) = state.active.write() {
        if active
            .as_ref()
            .is_some_and(|current| current.id == generation.id)
        {
            *active = None;
        }
    };
}

async fn handle(
    request: Request<Incoming>,
    policy: HostPolicy,
    config: Arc<ValidatedConfig>,
    state: Arc<ProxyState>,
    connection_slots: Arc<Semaphore>,
) -> Result<Response<Full<Bytes>>, Infallible> {
    let generation = state.active.read().ok().and_then(|value| value.clone());
    let Some(generation) = generation else {
        return Ok(response(StatusCode::SERVICE_UNAVAILABLE));
    };
    if generation.cancel.is_cancelled() {
        return Ok(response(StatusCode::SERVICE_UNAVAILABLE));
    }
    if !valid_request_shape(&request)
        || request
            .headers()
            .contains_key(http::header::TRANSFER_ENCODING)
        || request
            .headers()
            .get(http::header::CONTENT_LENGTH)
            .is_some_and(|value| value.as_bytes() != b"0")
    {
        generation.reject_policy();
        return Ok(response(StatusCode::BAD_REQUEST));
    }
    if request.method() != Method::CONNECT {
        return Ok(handle_plain_http(request, policy, config, generation, connection_slots).await);
    }
    let Some(authority) = request.uri().authority() else {
        generation.reject_policy();
        return Ok(response(StatusCode::BAD_REQUEST));
    };
    if authority.port_u16() != Some(443) {
        generation.reject_policy();
        return Ok(response(StatusCode::FORBIDDEN));
    }
    let authority = authority.as_str().to_owned();
    let Ok(url) = Url::parse(&format!("https://{authority}")) else {
        generation.reject_policy();
        return Ok(response(StatusCode::BAD_REQUEST));
    };
    let Some(host) = url.host_str() else {
        generation.reject_policy();
        return Ok(response(StatusCode::FORBIDDEN));
    };
    if url.username() != ""
        || url.password().is_some()
        || url.port_or_known_default() != Some(443)
        || !policy.allows(host)
    {
        generation.reject_policy();
        return Ok(response(StatusCode::FORBIDDEN));
    }
    let permit = match connection_slots.try_acquire_owned() {
        Ok(permit) => permit,
        Err(_) => return Ok(response(StatusCode::TOO_MANY_REQUESTS)),
    };
    let ips = match tokio::select! {
        _ = generation.cancel.cancelled() => {
            return Ok(response(StatusCode::SERVICE_UNAVAILABLE));
        }
        result = policy::resolve_public(
            &url,
            Duration::from_millis(config.raw.network.dns_timeout_ms),
        ) => result,
    } {
        Ok(ips) => ips,
        Err(_) => {
            generation.reject_policy();
            return Ok(response(StatusCode::FORBIDDEN));
        }
    };
    let task_generation = generation.clone();
    generation.track(async move {
        let _permit = permit;
        let upgraded = tokio::select! {
            _ = task_generation.cancel.cancelled() => return,
            result = hyper::upgrade::on(request) => result,
        };
        let Ok(upgraded) = upgraded else {
            return;
        };
        let mut upstream = None;
        for ip in ips {
            let connected = tokio::select! {
                _ = task_generation.cancel.cancelled() => return,
                result = tokio::time::timeout(
                    Duration::from_millis(config.raw.network.connect_timeout_ms),
                    TcpStream::connect((ip, 443)),
                ) => result,
            };
            if let Ok(Ok(stream)) = connected {
                upstream = Some(stream);
                break;
            }
        }
        let Some(upstream) = upstream else {
            return;
        };
        let client = TokioIo::new(upgraded);
        let (client_read, client_write) = tokio::io::split(client);
        let (upstream_read, upstream_write) = upstream.into_split();
        let sent = copy_bounded(
            client_read,
            upstream_write,
            config.raw.network.max_tunnel_sent_bytes,
            &task_generation.sent_remaining,
            &task_generation.sent,
            &task_generation.cancel,
        );
        let received = copy_bounded(
            upstream_read,
            client_write,
            config.raw.network.max_tunnel_received_bytes,
            &task_generation.received_remaining,
            &task_generation.received,
            &task_generation.cancel,
        );
        let (sent_exhausted, received_exhausted) = tokio::join!(sent, received);
        if sent_exhausted || received_exhausted {
            task_generation
                .exhausted_count
                .fetch_add(1, Ordering::Relaxed);
            task_generation.cancel.cancel();
        }
    });
    Ok(response(StatusCode::OK))
}

async fn handle_plain_http(
    request: Request<Incoming>,
    policy: HostPolicy,
    config: Arc<ValidatedConfig>,
    generation: Arc<RequestGeneration>,
    connection_slots: Arc<Semaphore>,
) -> Response<Full<Bytes>> {
    if !config.raw.allow_http || !matches!(*request.method(), Method::GET | Method::HEAD) {
        generation.reject_policy();
        return response(StatusCode::METHOD_NOT_ALLOWED);
    }
    let raw_url = request.uri().to_string();
    let Ok(url) = policy::validate_url(&raw_url, true, &policy) else {
        generation.reject_policy();
        return response(StatusCode::FORBIDDEN);
    };
    if url.scheme() != "http" {
        generation.reject_policy();
        return response(StatusCode::METHOD_NOT_ALLOWED);
    }
    let Ok(_permit) = connection_slots.try_acquire_owned() else {
        return response(StatusCode::TOO_MANY_REQUESTS);
    };
    let ips = match tokio::select! {
        _ = generation.cancel.cancelled() => {
            return response(StatusCode::SERVICE_UNAVAILABLE);
        }
        result = policy::resolve_public(
            &url,
            Duration::from_millis(config.raw.network.dns_timeout_ms),
        ) => result,
    } {
        Ok(ips) => ips,
        Err(_) => {
            generation.reject_policy();
            return response(StatusCode::FORBIDDEN);
        }
    };
    let estimated_sent = request_size_estimate(&request);
    if reserve(&generation.sent_remaining, estimated_sent) < estimated_sent {
        generation.exhaust();
        return response(StatusCode::PAYLOAD_TOO_LARGE);
    }
    generation.sent.fetch_add(estimated_sent, Ordering::Relaxed);

    let mut upstream = None;
    for ip in ips {
        let connected = tokio::select! {
            _ = generation.cancel.cancelled() => {
                return response(StatusCode::SERVICE_UNAVAILABLE);
            }
            result = tokio::time::timeout(
                Duration::from_millis(config.raw.network.connect_timeout_ms),
                TcpStream::connect((ip, 80)),
            ) => result,
        };
        if let Ok(Ok(stream)) = connected {
            upstream = Some(stream);
            break;
        }
    }
    let Some(upstream) = upstream else {
        return response(StatusCode::BAD_GATEWAY);
    };
    let handshake = tokio::select! {
        _ = generation.cancel.cancelled() => {
            return response(StatusCode::SERVICE_UNAVAILABLE);
        }
        result = client_http1::handshake::<_, Empty<Bytes>>(TokioIo::new(upstream)) => result,
    };
    let Ok((mut sender, connection)) = handshake else {
        return response(StatusCode::BAD_GATEWAY);
    };
    generation.track(async move {
        let _ = connection.await;
    });

    let mut path = if url.path().is_empty() {
        "/".to_owned()
    } else {
        url.path().to_owned()
    };
    if let Some(query) = url.query() {
        path.push('?');
        path.push_str(query);
    }
    let mut outgoing = Request::builder()
        .method(request.method().clone())
        .uri(path)
        .body(Empty::new())
        .expect("validated origin-form request");
    for (name, value) in request.headers() {
        if !is_hop_header(name)
            && !is_connection_nominated(request.headers(), name)
            && name != http::header::HOST
        {
            outgoing.headers_mut().append(name, value.clone());
        }
    }
    if let Some(host) = url.host_str() {
        if let Ok(value) = http::HeaderValue::from_str(host) {
            outgoing.headers_mut().insert(http::header::HOST, value);
        }
    }
    outgoing.headers_mut().insert(
        http::header::CONNECTION,
        http::HeaderValue::from_static("close"),
    );
    let sent = tokio::select! {
        _ = generation.cancel.cancelled() => {
            return response(StatusCode::SERVICE_UNAVAILABLE);
        }
        result = sender.send_request(outgoing) => result,
    };
    let Ok(upstream_response) = sent else {
        return response(StatusCode::BAD_GATEWAY);
    };
    let (parts, mut body) = upstream_response.into_parts();
    let header_bytes = parts.headers.iter().fold(0_usize, |total, (name, value)| {
        total.saturating_add(name.as_str().len() + value.as_bytes().len())
    });
    if parts.headers.len() > 100
        || header_bytes > 64 * 1024
        || parts
            .headers
            .values()
            .any(|value| value.as_bytes().len() > 16 * 1024)
    {
        return response(StatusCode::BAD_GATEWAY);
    }
    let mut bytes = Vec::new();
    let mut response_remaining = config.raw.network.max_http_response_bytes;
    loop {
        let frame = tokio::select! {
            _ = generation.cancel.cancelled() => {
                return response(StatusCode::SERVICE_UNAVAILABLE);
            }
            frame = body.frame() => frame,
        };
        let Some(frame) = frame else {
            break;
        };
        let Ok(frame) = frame else {
            return response(StatusCode::BAD_GATEWAY);
        };
        let Some(data) = frame.data_ref() else {
            continue;
        };
        let desired = (data.len() as u64).min(response_remaining);
        let allowed = reserve(&generation.received_remaining, desired);
        if allowed > 0 {
            bytes.extend_from_slice(&data[..allowed as usize]);
            generation.received.fetch_add(allowed, Ordering::Relaxed);
            response_remaining -= allowed;
        }
        if allowed < data.len() as u64 {
            generation.exhaust();
            return response(StatusCode::PAYLOAD_TOO_LARGE);
        }
    }

    let mut downstream = Response::builder()
        .status(parts.status)
        .body(Full::new(Bytes::from(bytes)))
        .expect("upstream status is valid");
    for (name, value) in &parts.headers {
        if !is_hop_header(name) && !is_connection_nominated(&parts.headers, name) {
            downstream.headers_mut().append(name, value.clone());
        }
    }
    downstream
}

fn valid_request_shape<B>(request: &Request<B>) -> bool {
    request.uri().to_string().len() <= 2_048
        && request.headers().len() <= 100
        && request
            .headers()
            .iter()
            .try_fold(0_usize, |total, (name, value)| {
                (value.as_bytes().len() <= 16 * 1024)
                    .then(|| total.saturating_add(name.as_str().len() + value.as_bytes().len()))
            })
            .is_some_and(|total| total <= 64 * 1024)
}

fn is_connection_nominated(headers: &http::HeaderMap, name: &HeaderName) -> bool {
    headers
        .get_all(http::header::CONNECTION)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|value| value.split(','))
        .any(|value| value.trim().eq_ignore_ascii_case(name.as_str()))
}

fn request_size_estimate(request: &Request<Incoming>) -> u64 {
    let mut bytes = request.method().as_str().len() + request.uri().to_string().len() + 16;
    for (name, value) in request.headers() {
        bytes = bytes.saturating_add(name.as_str().len() + value.as_bytes().len() + 4);
    }
    bytes as u64
}

fn is_hop_header(name: &HeaderName) -> bool {
    matches!(
        name.as_str(),
        "connection"
            | "keep-alive"
            | "proxy-authenticate"
            | "proxy-authorization"
            | "proxy-connection"
            | "te"
            | "trailer"
            | "transfer-encoding"
            | "upgrade"
            | "content-length"
            | "alt-svc"
    )
}

async fn copy_bounded<R, W>(
    mut reader: R,
    mut writer: W,
    tunnel_maximum: u64,
    request_remaining: &AtomicU64,
    metric: &AtomicU64,
    cancel: &CancellationToken,
) -> bool
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin,
{
    let mut tunnel_remaining = tunnel_maximum;
    let mut buffer = [0_u8; 16 * 1024];
    loop {
        let read = tokio::select! {
            _ = cancel.cancelled() => return false,
            result = reader.read(&mut buffer) => match result {
                Ok(0) | Err(_) => return false,
                Ok(read) => read,
            },
        };
        let allowed = reserve(request_remaining, (read as u64).min(tunnel_remaining));
        if allowed == 0 {
            return true;
        }
        let written = tokio::select! {
            _ = cancel.cancelled() => return false,
            result = writer.write_all(&buffer[..allowed as usize]) => result,
        };
        if written.is_err() {
            return false;
        }
        metric.fetch_add(allowed, Ordering::Relaxed);
        tunnel_remaining -= allowed;
        if allowed < read as u64 {
            return true;
        }
    }
}

fn reserve(remaining: &AtomicU64, requested: u64) -> u64 {
    let mut current = remaining.load(Ordering::Acquire);
    loop {
        let reserved = current.min(requested);
        if reserved == 0 {
            return 0;
        }
        match remaining.compare_exchange_weak(
            current,
            current - reserved,
            Ordering::AcqRel,
            Ordering::Acquire,
        ) {
            Ok(_) => return reserved,
            Err(actual) => current = actual,
        }
    }
}

impl Drop for LoopbackProxy {
    fn drop(&mut self) {
        self.close();
    }
}

fn response(status: StatusCode) -> Response<Full<Bytes>> {
    Response::builder()
        .status(status)
        .body(Full::new(Bytes::new()))
        .expect("valid proxy response")
}

#[cfg(test)]
mod tests;
