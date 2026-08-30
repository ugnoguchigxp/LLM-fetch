use super::{
    is_bot_challenge, normalize_source_text, truncate_to_characters, truncation_limitation,
    valid_request_id, validate_fetch_options, QueueReservation,
};
use crate::{
    config::Config,
    contracts::{FetchRequest, SourceInput},
};
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};

#[test]
fn truncates_at_a_unicode_character_boundary() {
    let mut value = "日本語abc".to_owned();
    assert!(truncate_to_characters(&mut value, 2));
    assert_eq!(value, "日本");
}

#[test]
fn validates_request_id_alphabet_and_length() {
    assert!(valid_request_id("search:result-1"));
    assert!(!valid_request_id("contains space"));
    assert!(!valid_request_id(&"a".repeat(129)));
}

#[test]
fn normalizes_source_line_breaks_and_rejects_controls() {
    assert_eq!(
        normalize_source_text("  two\n\tlines  ", true).unwrap(),
        "two lines"
    );
    assert!(normalize_source_text("bad\0value", true).is_err());
}

#[test]
fn rejects_source_text_before_unbounded_normalization_work() {
    let config = Config::default().validate().unwrap();
    let mut request = FetchRequest {
        request_id: "bounded-source".into(),
        session_id: None,
        url: "https://example.com/".into(),
        timeout_ms: None,
        settle_quiet_ms: None,
        max_characters: None,
        requested_use: None,
        source: Some(SourceInput {
            provider: "test".into(),
            query: "x".repeat(4_097),
            rank: 1,
            snippet: None,
        }),
    };
    assert!(validate_fetch_options(&mut request, &config).is_err());
}

#[test]
fn bot_challenge_detection_requires_short_marker_backed_content() {
    assert!(is_bot_challenge(
        "Reference",
        "Please verify you are human with this captcha.",
        true
    ));
    assert!(!is_bot_challenge(
        "How CAPTCHA systems work",
        "This article explains how sites verify you are human.",
        false
    ));
    assert!(!is_bot_challenge(
        "Attention Required",
        &"ordinary article text ".repeat(300),
        true
    ));
}

#[test]
fn truncation_reasons_have_stable_user_facing_limitations() {
    assert_eq!(
        truncation_limitation(&crate::contracts::TruncationReason::SecurityCharacterLimit),
        "Security character inspection limit reached."
    );
    assert_eq!(
        truncation_limitation(&crate::contracts::TruncationReason::DomSettleTimeout),
        "DOM settling timed out."
    );
}

#[test]
fn queue_reservations_are_bounded_and_released() {
    let counter = Arc::new(AtomicUsize::new(0));
    assert!(QueueReservation::reserve(counter.clone(), 0).is_err());
    let reservation = QueueReservation::reserve(counter.clone(), 1).unwrap();
    assert_eq!(counter.load(Ordering::Acquire), 1);
    assert!(QueueReservation::reserve(counter.clone(), 1).is_err());
    drop(reservation);
    assert_eq!(counter.load(Ordering::Acquire), 0);
}
