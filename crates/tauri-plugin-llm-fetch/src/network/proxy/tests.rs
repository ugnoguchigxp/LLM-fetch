use super::*;
use crate::config::Config;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

#[test]
fn reserves_an_aggregate_budget_atomically() {
    let budget = AtomicU64::new(10);
    assert_eq!(reserve(&budget, 6), 6);
    assert_eq!(reserve(&budget, 6), 4);
    assert_eq!(reserve(&budget, 1), 0);
}

#[tokio::test]
async fn network_is_disabled_until_a_request_generation_starts() {
    let config = Config::default().validate().unwrap();
    let proxy = LoopbackProxy::start(HostPolicy::global(&["example.com".into()]).unwrap(), config)
        .await
        .unwrap();
    let address = proxy.url().socket_addrs(|| None).unwrap()[0];
    let mut client = TcpStream::connect(address).await.unwrap();
    client
        .write_all(b"CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n")
        .await
        .unwrap();
    let mut response = vec![0; 128];
    let received = client.read(&mut response).await.unwrap();
    assert!(std::str::from_utf8(&response[..received])
        .unwrap()
        .starts_with("HTTP/1.1 503"));
}

#[tokio::test]
async fn rejects_a_non_allowlisted_connect_target() {
    let config = Config::default().validate().unwrap();
    let proxy = LoopbackProxy::start(HostPolicy::global(&["example.com".into()]).unwrap(), config)
        .await
        .unwrap();
    let generation = proxy.begin_request().unwrap();
    let address = proxy.url().socket_addrs(|| None).unwrap()[0];
    let mut client = TcpStream::connect(address).await.unwrap();
    client
        .write_all(b"CONNECT localhost:443 HTTP/1.1\r\nHost: localhost:443\r\n\r\n")
        .await
        .unwrap();
    let mut response = vec![0; 128];
    let received = client.read(&mut response).await.unwrap();
    assert!(std::str::from_utf8(&response[..received])
        .unwrap()
        .starts_with("HTTP/1.1 403"));
    assert!(generation.policy_violated());
    assert!(generation.finish().await.policy_violated);
}

#[test]
fn validates_proxy_request_limits_and_connection_nominated_headers() {
    let request = Request::builder()
        .uri("http://example.com/")
        .header(http::header::CONNECTION, "x-remove")
        .header("x-remove", "secret")
        .body(())
        .unwrap();
    assert!(valid_request_shape(&request));
    assert!(is_connection_nominated(
        request.headers(),
        &HeaderName::from_static("x-remove")
    ));

    let oversized = Request::builder()
        .uri(format!("http://example.com/{}", "a".repeat(2_048)))
        .body(())
        .unwrap();
    assert!(!valid_request_shape(&oversized));
}

#[tokio::test]
async fn completed_root_connection_tasks_are_reaped_while_proxy_stays_alive() {
    let state = ProxyState {
        active: RwLock::new(None),
        next_generation: AtomicU64::new(1),
        closed: AtomicBool::new(false),
        root_tasks: Mutex::new(TrackedTasks {
            accepting: true,
            handles: Vec::new(),
        }),
    };

    for _ in 0..8 {
        let handle = tokio::spawn(async {});
        tokio::task::yield_now().await;
        state.track_root_handle(handle);
    }

    let tracked = state.root_tasks.lock().unwrap().handles.len();
    assert!(tracked <= 1, "completed handles accumulated: {tracked}");
}
