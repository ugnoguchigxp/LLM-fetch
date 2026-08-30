use super::*;

#[test]
fn rejects_framing_control_characters_but_allows_text_whitespace() {
    assert!(has_disallowed_control("title\0injected"));
    assert!(has_disallowed_control("title\u{0085}injected"));
    assert!(!has_disallowed_control("line one\nline two\tvalue\r"));
}

fn event(phase: LoadPhase) -> LoadEvent {
    LoadEvent {
        phase,
        url: Url::parse("https://example.com/").unwrap(),
    }
}

#[tokio::test]
async fn waits_for_a_new_started_and_finished_pair() {
    let (sender, _) = broadcast::channel(8);
    let mut receiver = sender.subscribe();
    sender.send(event(LoadPhase::Finished)).unwrap();
    sender.send(event(LoadPhase::Started)).unwrap();
    sender.send(event(LoadPhase::Finished)).unwrap();
    let count = wait_for_main_page(
        &mut receiver,
        Duration::from_millis(100),
        &CancellationToken::new(),
    )
    .await
    .unwrap();
    assert_eq!(count, 1);
}

#[tokio::test]
async fn waits_for_the_internal_document_before_exposing_a_worker() {
    let (sender, _) = broadcast::channel(8);
    let mut receiver = sender.subscribe();
    sender.send(event(LoadPhase::Finished)).unwrap();
    sender
        .send(LoadEvent {
            phase: LoadPhase::Finished,
            url: Url::parse(INTERNAL_URL).unwrap(),
        })
        .unwrap();

    wait_for_internal_page(&mut receiver, Duration::from_millis(100))
        .await
        .unwrap();
}

#[test]
fn reset_rejects_a_navigation_that_raced_with_extraction() {
    let policy = HostPolicy::global(&["example.com".into()]).unwrap();
    let gate = NavigationGate::new(policy, false);
    let navigation = gate.begin().unwrap();
    assert!(gate.accept(&Url::parse("https://example.com/first").unwrap()));
    let extracted_generation = gate.generation().unwrap();
    assert!(gate.accept(&Url::parse("https://example.com/raced").unwrap()));
    assert_eq!(
        gate.prepare_reset(extracted_generation).unwrap_err().code,
        ErrorCode::NavigationUnstable
    );
    drop(navigation);
}

#[test]
fn active_page_cannot_navigate_to_the_internal_reset_url() {
    let policy = HostPolicy::global(&["example.com".into()]).unwrap();
    let gate = NavigationGate::new(policy, false);
    let mut violations = gate.violations.subscribe();
    let navigation = gate.begin().unwrap();

    assert!(!gate.accept(&Url::parse(INTERNAL_URL).unwrap()));
    assert_eq!(
        violations.try_recv().unwrap(),
        ErrorCode::NavigationUnstable
    );
    drop(navigation);
}

#[test]
fn reset_rejects_external_navigation_without_hiding_the_race() {
    let policy = HostPolicy::global(&["example.com".into()]).unwrap();
    let gate = NavigationGate::new(policy, false);
    let mut violations = gate.violations.subscribe();
    let navigation = gate.begin().unwrap();
    assert!(gate.accept(&Url::parse("https://example.com/first").unwrap()));
    gate.prepare_reset(1).unwrap();

    assert!(!gate.accept(&Url::parse("https://example.com/raced").unwrap()));
    assert_eq!(
        violations.try_recv().unwrap(),
        ErrorCode::NavigationUnstable
    );
    drop(navigation);
}
