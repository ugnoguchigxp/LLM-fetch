use crate::contracts::FetchStage;
use serde::Serialize;
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ErrorCode {
    InvalidInput,
    UnsupportedPlatform,
    BackgroundUnsupported,
    WebviewUnavailable,
    SessionNotFound,
    SessionClosed,
    SessionCapacity,
    QueueFull,
    DuplicateRequest,
    UnsafeUrl,
    DnsFailure,
    ProxyFailure,
    NavigationFailed,
    NavigationUnstable,
    EvaluationFailed,
    ResponseTooLarge,
    UnsupportedContentType,
    ContentInsufficient,
    BotChallenge,
    GuardFailed,
    Timeout,
    Cancelled,
    Internal,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ErrorResponse {
    pub code: ErrorCode,
    pub message: &'static str,
    pub retryable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stage: Option<FetchStage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<Uuid>,
}

impl ErrorResponse {
    pub fn new(code: ErrorCode) -> Self {
        let (message, retryable) = match code {
            ErrorCode::InvalidInput => ("The request is invalid.", false),
            ErrorCode::UnsupportedPlatform => ("This platform is not supported.", false),
            ErrorCode::BackgroundUnsupported => (
                "Reliable background WebView execution is not supported on this platform.",
                false,
            ),
            ErrorCode::WebviewUnavailable => ("The background WebView is unavailable.", false),
            ErrorCode::SessionNotFound => ("The session was not found.", false),
            ErrorCode::SessionClosed => ("The session is closing or closed.", false),
            ErrorCode::SessionCapacity => ("The background session capacity is exhausted.", true),
            ErrorCode::QueueFull => ("The request queue is full.", true),
            ErrorCode::DuplicateRequest => ("The request ID is already active.", false),
            ErrorCode::UnsafeUrl => ("The URL or resolved network target is not allowed.", false),
            ErrorCode::DnsFailure => ("DNS resolution failed.", true),
            ErrorCode::ProxyFailure => ("The egress proxy failed.", true),
            ErrorCode::NavigationFailed => ("The WebView navigation failed.", true),
            ErrorCode::NavigationUnstable => (
                "The page continued navigating and could not be stabilized.",
                true,
            ),
            ErrorCode::EvaluationFailed => ("The page could not be evaluated safely.", true),
            ErrorCode::ResponseTooLarge => {
                ("The extraction response exceeded its size limit.", false)
            }
            ErrorCode::UnsupportedContentType => ("The page content type is not supported.", false),
            ErrorCode::ContentInsufficient => {
                ("The page did not contain enough readable text.", false)
            }
            ErrorCode::BotChallenge => ("The page appears to be a bot challenge.", false),
            ErrorCode::GuardFailed => ("The content guard failed.", false),
            ErrorCode::Timeout => ("The request timed out.", true),
            ErrorCode::Cancelled => ("The request was cancelled.", false),
            ErrorCode::Internal => ("An internal error occurred.", false),
        };
        Self {
            code,
            message,
            retryable,
            stage: None,
            request_id: None,
            session_id: None,
        }
    }

    pub fn stage(mut self, stage: FetchStage) -> Self {
        self.stage = Some(stage);
        self
    }
    pub fn request_id(mut self, request_id: impl Into<String>) -> Self {
        self.request_id = Some(request_id.into());
        self
    }
    pub fn session_id(mut self, session_id: Uuid) -> Self {
        self.session_id = Some(session_id);
        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn public_error_json_contains_only_bounded_metadata() {
        let error = ErrorResponse::new(ErrorCode::Timeout)
            .stage(FetchStage::Navigating)
            .request_id("request-1");
        assert_eq!(
            serde_json::to_value(error).unwrap(),
            json!({
                "code": "TIMEOUT",
                "message": "The request timed out.",
                "retryable": true,
                "stage": "navigating",
                "requestId": "request-1"
            })
        );
    }
}
