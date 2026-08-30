use crate::errors::{ErrorCode, ErrorResponse};
use serde::Deserialize;
use std::{collections::HashSet, sync::Arc, time::Duration};

#[derive(Clone, Debug, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct Config {
    pub max_sessions: usize,
    pub max_queue_depth: usize,
    pub request_timeout_ms: u64,
    pub navigation_timeout_ms: u64,
    pub settle_quiet_ms: u64,
    pub settle_timeout_ms: u64,
    pub eval_timeout_ms: u64,
    pub session_create_timeout_ms: u64,
    pub session_idle_timeout_ms: u64,
    pub max_characters: usize,
    pub max_payload_bytes: usize,
    pub max_dom_nodes: usize,
    pub max_dom_depth: usize,
    pub max_candidates: usize,
    pub max_segments: usize,
    pub max_segment_characters: usize,
    pub max_security_characters: usize,
    pub allow_http: bool,
    pub allowed_hosts: Vec<String>,
    pub require_reliable_background: bool,
    pub viewport_width: f64,
    pub viewport_height: f64,
    pub network: NetworkConfig,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct NetworkConfig {
    pub dns_timeout_ms: u64,
    pub connect_timeout_ms: u64,
    pub max_connections: usize,
    pub max_http_response_bytes: u64,
    pub max_tunnel_received_bytes: u64,
    pub max_tunnel_sent_bytes: u64,
    pub max_request_received_bytes: u64,
    pub max_request_sent_bytes: u64,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            max_sessions: 2,
            max_queue_depth: 32,
            request_timeout_ms: 30_000,
            navigation_timeout_ms: 15_000,
            settle_quiet_ms: 750,
            settle_timeout_ms: 5_000,
            eval_timeout_ms: 2_000,
            session_create_timeout_ms: 10_000,
            session_idle_timeout_ms: 300_000,
            max_characters: 100_000,
            max_payload_bytes: 2_000_000,
            max_dom_nodes: 100_000,
            max_dom_depth: 512,
            max_candidates: 512,
            max_segments: 128,
            max_segment_characters: 4_096,
            max_security_characters: 250_000,
            allow_http: false,
            allowed_hosts: vec!["*".into()],
            require_reliable_background: true,
            viewport_width: 1280.0,
            viewport_height: 900.0,
            network: NetworkConfig::default(),
        }
    }
}

impl Default for NetworkConfig {
    fn default() -> Self {
        Self {
            dns_timeout_ms: 3_000,
            connect_timeout_ms: 5_000,
            max_connections: 32,
            max_http_response_bytes: 5_000_000,
            max_tunnel_received_bytes: 15_000_000,
            max_tunnel_sent_bytes: 1_000_000,
            max_request_received_bytes: 25_000_000,
            max_request_sent_bytes: 2_000_000,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum HostPattern {
    AnyPublic,
    Exact(String),
    SubdomainsOf(String),
}

#[derive(Clone, Debug)]
pub struct HostPolicy {
    global: Vec<HostPattern>,
    session: Option<Vec<HostPattern>>,
}

impl HostPolicy {
    pub fn global(patterns: &[String]) -> Result<Self, ErrorResponse> {
        Ok(Self {
            global: compile_patterns(patterns)?,
            session: None,
        })
    }
    pub fn scoped(&self, patterns: &[String]) -> Result<Self, ErrorResponse> {
        let session = compile_patterns(patterns)?;
        if session.iter().any(|candidate| {
            !self
                .global
                .iter()
                .any(|global| is_subset(candidate, global))
        }) {
            return Err(ErrorResponse::new(ErrorCode::InvalidInput));
        }
        Ok(Self {
            global: self.global.clone(),
            session: Some(session),
        })
    }
    pub fn allows(&self, host: &str) -> bool {
        let host = canonical_host(host).ok();
        let Some(host) = host else {
            return false;
        };
        matches_any(&self.global, &host)
            && self.session.as_ref().is_none_or(|v| matches_any(v, &host))
    }
}

fn is_subset(candidate: &HostPattern, global: &HostPattern) -> bool {
    match (candidate, global) {
        (_, HostPattern::AnyPublic) => true,
        (HostPattern::AnyPublic, _) => false,
        (HostPattern::Exact(candidate), HostPattern::Exact(global)) => candidate == global,
        (HostPattern::Exact(candidate), HostPattern::SubdomainsOf(global)) => {
            is_strict_subdomain(candidate, global)
        }
        (HostPattern::SubdomainsOf(candidate), HostPattern::SubdomainsOf(global)) => {
            candidate == global || is_strict_subdomain(candidate, global)
        }
        (HostPattern::SubdomainsOf(_), HostPattern::Exact(_)) => false,
    }
}

fn is_strict_subdomain(host: &str, suffix: &str) -> bool {
    host.len() > suffix.len()
        && host.ends_with(suffix)
        && host.as_bytes()[host.len() - suffix.len() - 1] == b'.'
}

fn matches_any(patterns: &[HostPattern], host: &str) -> bool {
    patterns.iter().any(|p| match p {
        HostPattern::AnyPublic => true,
        HostPattern::Exact(value) => value == host,
        HostPattern::SubdomainsOf(value) => {
            host.len() > value.len()
                && host.ends_with(value)
                && host.as_bytes()[host.len() - value.len() - 1] == b'.'
        }
    })
}

fn canonical_host(input: &str) -> Result<String, ErrorResponse> {
    if input.is_empty() || input.len() > 254 {
        return Err(ErrorResponse::new(ErrorCode::InvalidInput));
    }
    let input = input.strip_suffix('.').unwrap_or(input);
    let url::Host::Domain(host) =
        url::Host::parse(input).map_err(|_| ErrorResponse::new(ErrorCode::InvalidInput))?
    else {
        return Err(ErrorResponse::new(ErrorCode::InvalidInput));
    };
    let host = host.to_ascii_lowercase();
    if host.is_empty() || host.len() > 253 {
        return Err(ErrorResponse::new(ErrorCode::InvalidInput));
    }
    if host.split('.').any(|label| {
        label.is_empty()
            || label.len() > 63
            || label.starts_with('-')
            || label.ends_with('-')
            || !label
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
    }) {
        return Err(ErrorResponse::new(ErrorCode::InvalidInput));
    }
    Ok(host)
}

fn compile_patterns(patterns: &[String]) -> Result<Vec<HostPattern>, ErrorResponse> {
    if patterns.is_empty() || patterns.len() > 64 {
        return Err(ErrorResponse::new(ErrorCode::InvalidInput));
    }
    let mut seen = HashSet::new();
    let mut result = Vec::with_capacity(patterns.len());
    for pattern in patterns {
        let value = pattern.trim();
        if value != pattern {
            return Err(ErrorResponse::new(ErrorCode::InvalidInput));
        }
        let compiled = if value == "*" {
            HostPattern::AnyPublic
        } else if let Some(suffix) = value.strip_prefix("*.") {
            HostPattern::SubdomainsOf(canonical_host(suffix)?)
        } else if value.contains(['/', ':', '@']) {
            return Err(ErrorResponse::new(ErrorCode::InvalidInput));
        } else {
            HostPattern::Exact(canonical_host(value)?)
        };
        if !seen.insert(compiled.clone()) {
            return Err(ErrorResponse::new(ErrorCode::InvalidInput));
        }
        result.push(compiled);
    }
    if result.len() > 1 && result.iter().any(|p| matches!(p, HostPattern::AnyPublic)) {
        return Err(ErrorResponse::new(ErrorCode::InvalidInput));
    }
    Ok(result)
}

pub(crate) fn canonicalize_patterns(patterns: &[String]) -> Result<Vec<String>, ErrorResponse> {
    compile_patterns(patterns).map(|compiled| {
        compiled
            .into_iter()
            .map(|pattern| match pattern {
                HostPattern::AnyPublic => "*".to_owned(),
                HostPattern::Exact(host) => host,
                HostPattern::SubdomainsOf(host) => format!("*.{host}"),
            })
            .collect()
    })
}

#[derive(Clone)]
pub struct ValidatedConfig {
    pub raw: Config,
    pub global_hosts: HostPolicy,
    pub request_timeout: Duration,
    pub navigation_timeout: Duration,
    pub settle_quiet: Duration,
    pub settle_timeout: Duration,
    pub eval_timeout: Duration,
    pub session_create_timeout: Duration,
    pub session_idle_timeout: Duration,
}

impl Config {
    pub fn validate(self) -> Result<Arc<ValidatedConfig>, ErrorResponse> {
        let invalid = || Err(ErrorResponse::new(ErrorCode::InvalidInput));
        if !(1..=8).contains(&self.max_sessions)
            || self.max_queue_depth > 256
            || !(1_000..=1_000_000).contains(&self.max_characters)
            || !(64_000..=5_000_000).contains(&self.max_payload_bytes)
            || !(1_000..=200_000).contains(&self.max_dom_nodes)
            || !(32..=1_024).contains(&self.max_dom_depth)
            || !(16..=2_048).contains(&self.max_candidates)
            || !(16..=512).contains(&self.max_segments)
            || !(256..=16_384).contains(&self.max_segment_characters)
            || !(10_000..=2_000_000).contains(&self.max_security_characters)
            || !(320.0..=3840.0).contains(&self.viewport_width)
            || !(240.0..=2160.0).contains(&self.viewport_height)
            || !self.viewport_width.is_finite()
            || !self.viewport_height.is_finite()
            || !(1..=256).contains(&self.network.max_connections)
            || !valid_network_bytes(self.network.max_http_response_bytes)
            || !valid_network_bytes(self.network.max_tunnel_received_bytes)
            || !valid_network_bytes(self.network.max_tunnel_sent_bytes)
            || !valid_network_bytes(self.network.max_request_received_bytes)
            || !valid_network_bytes(self.network.max_request_sent_bytes)
        {
            return invalid();
        }
        for ms in [
            self.request_timeout_ms,
            self.navigation_timeout_ms,
            self.settle_quiet_ms,
            self.settle_timeout_ms,
            self.eval_timeout_ms,
            self.session_create_timeout_ms,
            self.network.dns_timeout_ms,
            self.network.connect_timeout_ms,
        ] {
            if !(100..=300_000).contains(&ms) {
                return invalid();
            }
        }
        if !(1_000..=300_000).contains(&self.session_idle_timeout_ms) {
            return invalid();
        }
        let minimum = self
            .navigation_timeout_ms
            .checked_add(self.settle_timeout_ms)
            .and_then(|v| v.checked_add(self.eval_timeout_ms))
            .and_then(|v| v.checked_add(1_000))
            .ok_or_else(|| ErrorResponse::new(ErrorCode::InvalidInput))?;
        if self.settle_quiet_ms > self.settle_timeout_ms
            || minimum > self.request_timeout_ms
            || self.network.max_http_response_bytes > self.network.max_request_received_bytes
            || self.network.max_tunnel_received_bytes > self.network.max_request_received_bytes
            || self.network.max_tunnel_sent_bytes > self.network.max_request_sent_bytes
        {
            return invalid();
        }
        let global_hosts = HostPolicy::global(&self.allowed_hosts)?;
        Ok(Arc::new(ValidatedConfig {
            request_timeout: Duration::from_millis(self.request_timeout_ms),
            navigation_timeout: Duration::from_millis(self.navigation_timeout_ms),
            settle_quiet: Duration::from_millis(self.settle_quiet_ms),
            settle_timeout: Duration::from_millis(self.settle_timeout_ms),
            eval_timeout: Duration::from_millis(self.eval_timeout_ms),
            session_create_timeout: Duration::from_millis(self.session_create_timeout_ms),
            session_idle_timeout: Duration::from_millis(self.session_idle_timeout_ms),
            raw: self,
            global_hosts,
        }))
    }
}

fn valid_network_bytes(value: u64) -> bool {
    (64 * 1024..=250 * 1024 * 1024).contains(&value)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canonicalizes_an_internationalized_hostname() {
        assert_eq!(
            canonical_host("例え.テスト.").unwrap(),
            "xn--r8jz45g.xn--zckzah"
        );
    }

    #[test]
    fn rejects_invalid_hostname_and_accepts_explicit_plain_http_opt_in() {
        assert!(canonical_host("bad host.example").is_err());
        let config = Config {
            allow_http: true,
            ..Config::default()
        };
        assert!(config.validate().is_ok());
    }

    #[test]
    fn config_rejects_unknown_fields_and_ambiguous_wildcards() {
        assert!(serde_json::from_str::<Config>(r#"{"unknown":true}"#).is_err());
        assert!(HostPolicy::global(&["*".into(), "example.com".into()]).is_err());
        assert!(HostPolicy::global(&["*.Example.COM.".into()])
            .unwrap()
            .allows("www.example.com"));
        assert!(HostPolicy::global(&[" example.com".into()]).is_err());
        assert!(HostPolicy::global(&["example.com..".into()]).is_err());
    }

    #[test]
    fn session_patterns_must_be_subsets_of_the_global_policy() {
        let exact = HostPolicy::global(&["example.com".into()]).unwrap();
        assert!(exact.scoped(&["example.com".into()]).is_ok());
        assert!(exact.scoped(&["www.example.com".into()]).is_err());

        let wildcard = HostPolicy::global(&["*.example.com".into()]).unwrap();
        assert!(wildcard.scoped(&["api.example.com".into()]).is_ok());
        assert!(wildcard.scoped(&["*.api.example.com".into()]).is_ok());
        assert!(wildcard.scoped(&["example.com".into()]).is_err());
    }

    #[test]
    fn accepts_a_zero_length_queue_and_rejects_invalid_network_budgets() {
        let no_queue = Config {
            max_queue_depth: 0,
            ..Config::default()
        };
        assert!(no_queue.validate().is_ok());
        let invalid_budget = Config {
            network: NetworkConfig {
                max_request_sent_bytes: 0,
                ..NetworkConfig::default()
            },
            ..Config::default()
        };
        assert!(invalid_budget.validate().is_err());
    }

    #[test]
    fn global_idle_timeout_always_allows_a_reusable_session() {
        let invalid = Config {
            session_idle_timeout_ms: 999,
            ..Config::default()
        };
        assert!(invalid.validate().is_err());
        let minimum = Config {
            session_idle_timeout_ms: 1_000,
            ..Config::default()
        };
        assert!(minimum.validate().is_ok());
    }
}
