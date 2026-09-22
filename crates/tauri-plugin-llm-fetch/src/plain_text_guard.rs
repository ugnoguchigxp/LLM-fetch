use crate::{
    contracts::{GuardDecision, RequestedContextUse, SecurityFindingCategory},
    security,
};

/// Result of inspecting bounded search-result text with the plugin guard.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlainTextGuardOutcome {
    pub decision: GuardDecision,
    pub warning_categories: Vec<SecurityFindingCategory>,
    pub truncated_for_guard: bool,
}

/// Inspect provider, title, snippet, and URL text without exposing guard internals.
/// Oversized input is truncated and therefore evaluated fail-closed.
pub fn inspect_plain_text_bounded(text: &str, max_characters: usize) -> PlainTextGuardOutcome {
    let max_characters = max_characters.clamp(1_000, 2_000_000);
    let bounded: String = text.chars().take(max_characters + 1).collect();
    let truncated_for_guard = bounded.chars().count() > max_characters;
    let visible: String = bounded.chars().take(max_characters).collect();
    let inspection = security::inspect(
        &visible,
        &[],
        max_characters,
        RequestedContextUse::AnswerWithCitation,
        truncated_for_guard,
    );
    let mut warning_categories: Vec<SecurityFindingCategory> = inspection
        .result
        .findings
        .iter()
        .filter(|finding| !matches!(finding.category, SecurityFindingCategory::BenignMention))
        .map(|finding| finding.category.clone())
        .collect();
    warning_categories.sort_by_key(|category| {
        serde_json::to_value(category)
            .and_then(serde_json::from_value::<String>)
            .unwrap_or_default()
    });
    warning_categories.dedup();
    PlainTextGuardOutcome {
        decision: inspection.result.decision,
        warning_categories,
        truncated_for_guard,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allows_benign_text_and_fails_closed_on_truncation() {
        let benign = inspect_plain_text_bounded(
            "duckduckgo\nGardening guide\nHow to grow tomatoes.\nhttps://garden.example/",
            4_000,
        );
        assert!(!benign.truncated_for_guard);
        assert!(matches!(
            benign.decision,
            GuardDecision::Allow | GuardDecision::AllowWithWarning
        ));

        let long = format!(
            "duckduckgo\n{}\nhttps://example.com/",
            "word ".repeat(10_000)
        );
        let truncated = inspect_plain_text_bounded(&long, 4_000);
        assert!(truncated.truncated_for_guard);
        assert!(matches!(
            truncated.decision,
            GuardDecision::RequireApproval | GuardDecision::Deny
        ));
    }
}
