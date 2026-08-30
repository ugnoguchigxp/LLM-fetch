use crate::{
    config::HostPolicy,
    errors::{ErrorCode, ErrorResponse},
    webview::Worker,
};
use std::{
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};
use tauri::Runtime;
use tokio::sync::Mutex as AsyncMutex;

pub struct Session<R: Runtime> {
    pub policy: HostPolicy,
    pub worker: Arc<Worker<R>>,
    pub operation: Arc<AsyncMutex<()>>,
    pub exposed: bool,
    idle_timeout: Duration,
    last_used: Mutex<Instant>,
    active_requests: AtomicUsize,
    closed: AtomicBool,
    _permit: tokio::sync::OwnedSemaphorePermit,
}

impl<R: Runtime> Session<R> {
    pub fn new(
        policy: HostPolicy,
        worker: Arc<Worker<R>>,
        exposed: bool,
        idle_timeout: Duration,
        permit: tokio::sync::OwnedSemaphorePermit,
    ) -> Arc<Self> {
        Arc::new(Self {
            policy,
            worker,
            operation: Arc::new(AsyncMutex::new(())),
            exposed,
            idle_timeout,
            last_used: Mutex::new(Instant::now()),
            active_requests: AtomicUsize::new(0),
            closed: AtomicBool::new(false),
            _permit: permit,
        })
    }

    pub fn begin(self: &Arc<Self>) -> Result<SessionUse<R>, ErrorResponse> {
        if self.closed.load(Ordering::Acquire) {
            return Err(ErrorResponse::new(ErrorCode::SessionClosed));
        }
        self.active_requests.fetch_add(1, Ordering::AcqRel);
        if self.closed.load(Ordering::Acquire) {
            self.active_requests.fetch_sub(1, Ordering::AcqRel);
            return Err(ErrorResponse::new(ErrorCode::SessionClosed));
        }
        self.touch();
        Ok(SessionUse(self.clone()))
    }

    pub fn is_idle_expired(&self) -> bool {
        self.exposed
            && self.active_requests.load(Ordering::Acquire) == 0
            && self
                .last_used
                .lock()
                .is_ok_and(|last| last.elapsed() > self.idle_timeout)
    }

    pub fn close(&self) {
        if !self.closed.swap(true, Ordering::AcqRel) {
            self.worker.close();
        }
    }

    fn touch(&self) {
        if let Ok(mut last_used) = self.last_used.lock() {
            *last_used = Instant::now();
        }
    }
}

pub struct SessionUse<R: Runtime>(Arc<Session<R>>);
impl<R: Runtime> Drop for SessionUse<R> {
    fn drop(&mut self) {
        self.0.touch();
        self.0.active_requests.fetch_sub(1, Ordering::AcqRel);
    }
}

impl<R: Runtime> Drop for Session<R> {
    fn drop(&mut self) {
        self.close();
    }
}
