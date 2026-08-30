use crate::{
    config::HostPolicy,
    errors::{ErrorCode, ErrorResponse},
};
use ipnet::IpNet;
use std::net::IpAddr;
use tokio::time::timeout;
use url::Url;

const BLOCKED_V4: &[&str] = &[
    "0.0.0.0/8",
    "10.0.0.0/8",
    "100.64.0.0/10",
    "127.0.0.0/8",
    "169.254.0.0/16",
    "172.16.0.0/12",
    "192.0.0.0/24",
    "192.0.2.0/24",
    "192.88.99.0/24",
    "192.168.0.0/16",
    "198.18.0.0/15",
    "198.51.100.0/24",
    "203.0.113.0/24",
    "224.0.0.0/4",
    "240.0.0.0/4",
];
const BLOCKED_V6: &[&str] = &[
    "::/128",
    "::1/128",
    "::/96",
    "::ffff:0:0/96",
    "64:ff9b::/96",
    "64:ff9b:1::/48",
    "100::/64",
    "2001::/23",
    "2001:db8::/32",
    "2002::/16",
    "3fff::/20",
    "5f00::/16",
    "fc00::/7",
    "fe80::/10",
    "fec0::/10",
    "ff00::/8",
];

pub fn validate_url(
    raw: &str,
    allow_http: bool,
    policy: &HostPolicy,
) -> Result<Url, ErrorResponse> {
    if raw.is_empty() || raw.len() > 2048 {
        return Err(ErrorResponse::new(ErrorCode::InvalidInput));
    }
    let mut url = Url::parse(raw).map_err(|_| ErrorResponse::new(ErrorCode::InvalidInput))?;
    if url.fragment().is_some() {
        url.set_fragment(None);
    }
    if url.as_str().len() > 2048
        || url.username() != ""
        || url.password().is_some()
        || url.port().is_some()
    {
        return Err(ErrorResponse::new(ErrorCode::UnsafeUrl));
    }
    match url.scheme() {
        "https" => {}
        "http" if allow_http => {}
        _ => return Err(ErrorResponse::new(ErrorCode::UnsafeUrl)),
    }
    let host = url
        .host_str()
        .ok_or_else(|| ErrorResponse::new(ErrorCode::UnsafeUrl))?;
    if host.parse::<IpAddr>().is_ok()
        || matches!(host, "localhost" | "home.arpa")
        || host.ends_with(".localhost")
        || host.ends_with(".local")
        || host.ends_with(".home.arpa")
        || !policy.allows(host)
    {
        return Err(ErrorResponse::new(ErrorCode::UnsafeUrl));
    }
    Ok(url)
}

pub fn is_blocked_ip(ip: IpAddr) -> bool {
    let ranges = match ip {
        IpAddr::V4(_) => BLOCKED_V4,
        IpAddr::V6(_) => BLOCKED_V6,
    };
    ranges
        .iter()
        .any(|raw| raw.parse::<IpNet>().is_ok_and(|net| net.contains(&ip)))
}

/// Reject a hostname when any of its currently resolved answers is non-public.
/// The browser is still constrained to a host allowlist; this preflight is the
/// DNS-rebinding defence available through stable cross-platform Tauri APIs.
pub async fn resolve_public(
    url: &Url,
    dns_timeout: std::time::Duration,
) -> Result<Vec<IpAddr>, ErrorResponse> {
    let host = url
        .host_str()
        .ok_or_else(|| ErrorResponse::new(ErrorCode::UnsafeUrl))?;
    let port = url
        .port_or_known_default()
        .ok_or_else(|| ErrorResponse::new(ErrorCode::UnsafeUrl))?;
    let mut resolved = timeout(dns_timeout, tokio::net::lookup_host((host, port)))
        .await
        .map_err(|_| ErrorResponse::new(ErrorCode::DnsFailure))?
        .map_err(|_| ErrorResponse::new(ErrorCode::DnsFailure))?
        .map(|address| address.ip())
        .collect::<Vec<_>>();
    if resolved.is_empty() || resolved.len() > 64 || resolved.iter().any(|ip| is_blocked_ip(*ip)) {
        return Err(ErrorResponse::new(ErrorCode::UnsafeUrl));
    }
    resolved.sort_unstable_by_key(|ip| if ip.is_ipv4() { 0 } else { 1 });
    resolved.dedup();
    Ok(resolved)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::HostPolicy;
    #[test]
    fn blocks_private_networks() {
        assert!(is_blocked_ip("127.0.0.1".parse().unwrap()));
        assert!(is_blocked_ip("::1".parse().unwrap()));
        for raw in BLOCKED_V4.iter().chain(BLOCKED_V6) {
            let network = raw.parse::<IpNet>().unwrap();
            assert!(is_blocked_ip(network.network()));
        }
    }
    #[test]
    fn validates_https_url() {
        let policy = HostPolicy::global(&["example.com".into()]).unwrap();
        assert!(validate_url("https://example.com/a#x", false, &policy).is_ok());
        assert!(validate_url("http://example.com", false, &policy).is_err());
        assert!(validate_url("http://example.com", true, &policy).is_ok());
        assert!(validate_url("https://user@example.com", false, &policy).is_err());
        assert!(validate_url("https://example.com:444", false, &policy).is_err());
    }
}
