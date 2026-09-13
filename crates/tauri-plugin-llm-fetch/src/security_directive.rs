// Request grammar mirrors src/security/directive-context.ts. Shared corpus tests
// enforce the public decisions across TypeScript and Rust.
use regex::Regex;
use std::sync::LazyLock;

const COORDINATED_START: &str = r##"(?i)^[\s"'“”‘’`*>#-]*(?:please\s+)?(?:ignore|disregard|reveal|show|print|output|send|post|upload|call|invoke|execute|run|launch|open|remember|store|save|write|persist|add|change|update|disable|remove|bypass|override)\b"##;
const JAPANESE_REQUEST: &str = r##"^(?:にして|にし|して|し|を)?(?:ください|下さい|なさい|ろ|せよ|すること|するよう|して(?:[\s。！？.!?]|$)|しよう|せんか)|^(?:け|くこと|いてください|きなさい|き込んで|込んで|び出して|び出せ)"##;
const REFERENCE: &str =
    r##"(?i)\b(?:it|them|this|that|these|those)\b|(?:それ|これ|その値|この値|上記|前述)"##;
const NLP_TOKEN_SUFFIX: &str = r##"(?i)^\s*(?:probabilit\w*|embedding\w*|representation\w*|sequence\w*|count\w*|length\w*|prediction\w*|distribution\w*|vocabular\w*|ization)\b|^(?:の)?(?:確率|埋め込み|表現|列|数|長|予測|分布|化)"##;

const REQUEST_BOUNDARIES: &str = r##"(?:\n\s*\n|(?:^|\n)[A-Z][A-Z _-]{2,}\n|\n[ \t]*[-*][ \t]+)"##;

static GRAMMAR: LazyLock<[Regex; 5]> = LazyLock::new(|| {
    [
        COORDINATED_START,
        JAPANESE_REQUEST,
        REFERENCE,
        NLP_TOKEN_SUFFIX,
        REQUEST_BOUNDARIES,
    ]
    .map(|pattern| Regex::new(pattern).expect("valid directive grammar"))
});
static UNITS: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"[^.!?。！？;；]+[.!?。！？;；]*").unwrap());

static PREFIX_TOKENS: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r##"[^\s"'“”‘’`*>#-]+"##).unwrap());

fn english_request(prefix: &str) -> bool {
    let mut tokens = PREFIX_TOKENS
        .find_iter(prefix)
        .map(|m| m.as_str().to_ascii_lowercase())
        .filter(|word| {
            !matches!(
                word.as_str(),
                "please" | "kindly" | "now" | "then" | "next" | "finally" | "also" | "immediately"
            )
        });
    let word = tokens.next();
    match word.as_deref() {
        None => true,
        Some("can" | "could" | "would" | "will") => {
            tokens.next().as_deref() == Some("you") && tokens.next().is_none()
        }
        Some("you") => match tokens.next().as_deref() {
            None => true,
            Some("need" | "have") => {
                tokens.next().as_deref() == Some("to") && tokens.next().is_none()
            }
            Some("must" | "should" | "shall" | "will" | "can" | "could" | "would") => {
                tokens.next().is_none()
            }
            _ => false,
        },
        _ => false,
    }
}

pub struct DirectiveRule {
    action: Regex,
    target: Regex,
    secret: bool,
}

pub fn compile(action: &[&str], target: &[&str], secret: bool) -> DirectiveRule {
    let group = |words: &[&str], plural: bool| {
        let pattern = words
            .iter()
            .map(|word| {
                if word.is_ascii() {
                    format!(
                        r"\b{}{}\b",
                        regex::escape(word),
                        if plural { "(?:s)?" } else { "" }
                    )
                } else {
                    regex::escape(word)
                }
            })
            .collect::<Vec<_>>()
            .join("|");
        Regex::new(&format!("(?i)(?:{pattern})")).unwrap()
    };
    DirectiveRule {
        action: group(action, false),
        target: group(target, true),
        secret,
    }
}

fn target_match<'a>(rule: &DirectiveRule, text: &'a str) -> Option<regex::Match<'a>> {
    rule.target.find_iter(text).find(|m| {
        !(rule.secret
            && (m.as_str().eq_ignore_ascii_case("token") || m.as_str() == "トークン")
            && GRAMMAR[3].is_match(&text[m.end()..]))
    })
}

pub fn match_directive(rule: &DirectiveRule, text: &str) -> Option<(usize, usize)> {
    let units = UNITS.find_iter(text).collect::<Vec<_>>();
    let references = units
        .iter()
        .filter_map(|unit| {
            target_match(rule, unit.as_str())
                .map(|m| (unit.start() + m.start(), unit.start() + m.end()))
        })
        .collect::<Vec<_>>();
    if references.is_empty() {
        return None;
    }
    for unit in &units {
        if !rule.action.is_match(unit.as_str()) {
            continue;
        }
        let mut boundaries = unit
            .as_str()
            .match_indices([',', ':'])
            .map(|(i, _)| i + 1)
            .chain(GRAMMAR[4].find_iter(unit.as_str()).map(|m| m.end()))
            .collect::<Vec<_>>();
        boundaries.sort_unstable();
        let mut boundary_index = 0;
        let mut boundary = 0;
        for verb in rule.action.find_iter(unit.as_str()) {
            while boundary_index < boundaries.len() && boundaries[boundary_index] <= verb.start() {
                boundary = boundaries[boundary_index];
                boundary_index += 1;
            }
            let prefix = &unit.as_str()[boundary..verb.start()];
            let trimmed = prefix.trim_end();
            let before_and = if trimmed
                .get(trimmed.len().saturating_sub(4)..)
                .is_some_and(|s| s.eq_ignore_ascii_case("then"))
            {
                trimmed[..trimmed.len() - 4].trim_end()
            } else {
                trimmed
            };
            let coordinated = before_and
                .get(before_and.len().saturating_sub(3)..)
                .is_some_and(|s| s.eq_ignore_ascii_case("and"))
                && before_and[..before_and.len().saturating_sub(3)]
                    .chars()
                    .next_back()
                    .is_none_or(|c| !c.is_ascii_alphanumeric() && c != '_')
                && GRAMMAR[0].is_match(prefix);
            let suffix = &unit.as_str()[verb.end()..];
            let japanese = !verb.as_str().is_ascii();
            if if japanese {
                !GRAMMAR[1].is_match(suffix)
            } else {
                !(english_request(prefix) || coordinated)
            } {
                continue;
            }
            let (target_text, offset) = if japanese {
                (unit.as_str(), 0)
            } else {
                (suffix, verb.end())
            };
            if let Some(target) = target_match(rule, target_text) {
                return Some((
                    unit.start() + verb.start().min(offset + target.start()),
                    unit.start() + verb.end().max(offset + target.end()),
                ));
            }
            if !GRAMMAR[2].is_match(unit.as_str()) {
                continue;
            }
            let start = unit.start() + verb.start();
            let referenced = references
                .iter()
                .rev()
                .find(|m| m.0 <= start)
                .unwrap_or(&references[0]);
            return Some((
                start.min(referenced.0),
                (unit.start() + verb.end()).max(referenced.1),
            ));
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use crate::{
        contracts::{GuardDecision, RequestedContextUse, SecurityFindingLocation},
        security::inspect,
        webview::RawSecuritySegment,
    };

    #[test]
    fn polite_request_prefixes_handle_long_whitespace() {
        for prefix in [
            "Could you please ",
            "You must please ",
            "You have to ",
            "You need to ",
        ] {
            assert!(super::english_request(prefix));
        }
        assert!(!super::english_request("The model should "));
        assert!(!super::english_request("could the model "));
        assert!(!super::english_request("you are "));
        assert!(super::english_request(&format!(
            "Please{}",
            " ".repeat(150_000)
        )));
    }

    #[test]
    fn shared_corpus_retains_hidden_and_attribute_protection() {
        let fixture: serde_json::Value =
            serde_json::from_str(include_str!("../tests/fixtures/security/ts-guard-v1.json"))
                .unwrap();
        for case in fixture["cases"].as_array().unwrap() {
            for location in [
                SecurityFindingLocation::Hidden,
                SecurityFindingLocation::Comment,
                SecurityFindingLocation::Template,
                SecurityFindingLocation::Meta,
                SecurityFindingLocation::Attribute,
            ] {
                let body = case["text"].as_str().unwrap();
                let segment = RawSecuritySegment {
                    location,
                    text: body.into(),
                    truncated: false,
                    original_length: body.chars().count(),
                };
                let result = inspect(
                    "Factual reference material.",
                    &[segment],
                    250_000,
                    RequestedContextUse::ExtractFacts,
                    false,
                );
                let expected = if case["expected"]["findings"].as_array().unwrap().is_empty() {
                    GuardDecision::Allow
                } else {
                    GuardDecision::RequireApproval
                };
                assert_eq!(result.result.decision, expected, "{}", case["name"]);
            }
        }
    }
}
