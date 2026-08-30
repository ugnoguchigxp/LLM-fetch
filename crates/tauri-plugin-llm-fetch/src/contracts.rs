use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateSessionRequest {
    pub allowed_hosts: Vec<String>,
    pub idle_timeout_ms: Option<u64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FetchRequest {
    pub request_id: String,
    pub session_id: Option<Uuid>,
    pub url: String,
    pub timeout_ms: Option<u64>,
    pub settle_quiet_ms: Option<u64>,
    pub max_characters: Option<usize>,
    pub requested_use: Option<RequestedContextUse>,
    pub source: Option<SourceInput>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CancelRequest {
    pub request_id: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CloseSessionRequest {
    pub session_id: Uuid,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum RequestedContextUse {
    #[default]
    Summarize,
    AnswerWithCitation,
    ExtractFacts,
    SearchMore,
    CallReadonlyTool,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SourceInput {
    pub provider: String,
    pub query: String,
    pub rank: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub snippet: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceMetadata {
    pub kind: SourceKind,
    pub trust: TrustLevel,
    pub url: String,
    pub final_url: String,
    pub provider: String,
    pub query: String,
    pub rank: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub snippet: Option<String>,
    pub retrieved_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SourceKind {
    SearchResult,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TrustLevel {
    Untrusted,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RetrievedDocument {
    pub request_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<Uuid>,
    pub url: String,
    pub final_url: String,
    pub title: String,
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub excerpt: Option<String>,
    pub content_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
    pub fetched_at: String,
    pub fetch_method: FetchMethod,
    pub character_count: usize,
    pub truncated: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<SourceMetadata>,
    pub security: SecurityResult,
    pub diagnostics: FetchDiagnostics,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum FetchMethod {
    TauriWebview,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FetchDiagnostics {
    pub queued_ms: u64,
    pub navigation_ms: u64,
    pub settle_ms: u64,
    pub extraction_ms: u64,
    pub guard_ms: u64,
    pub navigation_count: u32,
    pub dom_nodes_visited: u32,
    pub network_received_bytes: u64,
    pub network_sent_bytes: u64,
    pub network_budget_exhausted: bool,
    pub truncation_reasons: Vec<TruncationReason>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SecurityResult {
    pub trust: TrustLevel,
    pub tainted: bool,
    pub guard: String,
    pub findings: Vec<SecurityFinding>,
    pub assurance: Assurance,
    pub decision: GuardDecision,
    pub reasons: Vec<String>,
    pub limitations: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SecurityFinding {
    pub category: SecurityFindingCategory,
    pub severity: SecurityFindingSeverity,
    #[serde(serialize_with = "serialize_confidence")]
    pub confidence: f32,
    pub location: SecurityFindingLocation,
    pub reason: String,
    pub techniques: Vec<String>,
    pub segment_hash: String,
}

fn serialize_confidence<S>(value: &f32, serializer: S) -> Result<S::Ok, S::Error>
where
    S: serde::Serializer,
{
    serializer.serialize_f64((f64::from(*value) * 100.0).round() / 100.0)
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Assurance {
    Low,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum GuardDecision {
    Allow,
    AllowWithWarning,
    RequireApproval,
    Deny,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SecurityFindingSeverity {
    Info,
    Low,
    Medium,
    High,
    Critical,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum SecurityFindingLocation {
    Visible,
    Hidden,
    Comment,
    Attribute,
    Meta,
    Template,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SecurityFindingCategory {
    InstructionOverride,
    RoleRedefinition,
    SecretExfiltration,
    ToolInvocation,
    ExternalSend,
    MemoryWrite,
    PolicyOverride,
    SourceSuppression,
    OutputControl,
    AuthorityClaim,
    HiddenInstruction,
    LowTrustAttribute,
    BenignMention,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum FetchStage {
    Queued,
    CreatingSession,
    Navigating,
    WaitingForDom,
    Extracting,
    Guarding,
    CleaningUp,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum TruncationReason {
    DomNodeLimit,
    DomDepthLimit,
    CandidateLimit,
    TextLimit,
    SegmentLimit,
    SegmentTextLimit,
    DomSettleTimeout,
    NetworkBudgetExhausted,
    SecurityCharacterLimit,
    FindingLimit,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    pub session_id: Uuid,
    pub created_at: String,
    pub idle_timeout_ms: u64,
    pub allowed_hosts: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CancelResult {
    pub accepted: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloseSessionResult {
    pub session_id: Uuid,
    pub closed: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginStatus {
    pub version: String,
    pub platform: String,
    pub support: PlatformSupport,
    pub active_sessions: usize,
    pub active_requests: usize,
    pub queued_requests: usize,
    pub shutting_down: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlatformSupport {
    pub overall: SupportLevel,
    pub proxy_enforcement: SupportLevel,
    pub background_execution: SupportLevel,
    pub incognito_storage: SupportLevel,
    pub reasons: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SupportLevel {
    Supported,
    BestEffort,
    Unsupported,
}

pub(crate) fn now() -> String {
    time::OffsetDateTime::now_utc()
        .format(time::macros::format_description!(
            "[year]-[month]-[day]T[hour]:[minute]:[second].[subsecond digits:3]Z"
        ))
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn fetch_request_contract_uses_camel_case_and_rejects_unknown_fields() {
        let request: FetchRequest = serde_json::from_value(json!({
            "requestId": "request-1",
            "url": "https://example.com/",
            "requestedUse": "answer_with_citation"
        }))
        .unwrap();
        assert_eq!(request.request_id, "request-1");
        assert_eq!(
            request.requested_use,
            Some(RequestedContextUse::AnswerWithCitation)
        );
        assert!(serde_json::from_value::<FetchRequest>(json!({
            "requestId": "request-1",
            "url": "https://example.com/",
            "unexpected": true
        }))
        .is_err());
    }

    #[test]
    fn public_enum_json_names_are_stable() {
        assert_eq!(
            serde_json::to_value(RequestedContextUse::CallReadonlyTool).unwrap(),
            json!("call_readonly_tool")
        );
        assert_eq!(
            serde_json::to_value(FetchStage::WaitingForDom).unwrap(),
            json!("waiting_for_dom")
        );
        assert_eq!(
            serde_json::to_value(TruncationReason::NetworkBudgetExhausted).unwrap(),
            json!("network_budget_exhausted")
        );
    }
}
