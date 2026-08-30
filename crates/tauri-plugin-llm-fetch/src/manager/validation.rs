use crate::{
    config::ValidatedConfig,
    contracts::FetchRequest,
    errors::{ErrorCode, ErrorResponse},
};

pub(super) fn valid_request_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-'))
}

pub(super) fn validate_fetch_options(
    request: &mut FetchRequest,
    config: &ValidatedConfig,
) -> Result<(), ErrorResponse> {
    if request
        .timeout_ms
        .is_some_and(|value| !(500..=config.raw.request_timeout_ms).contains(&value))
        || request
            .settle_quiet_ms
            .is_some_and(|value| !(100..=config.raw.settle_timeout_ms).contains(&value))
        || request
            .max_characters
            .is_some_and(|value| !(1_000..=config.raw.max_characters).contains(&value))
    {
        return Err(ErrorResponse::new(ErrorCode::InvalidInput));
    }
    if let Some(source) = request.source.as_mut() {
        if source.query.len() > 4_096
            || source
                .snippet
                .as_ref()
                .is_some_and(|snippet| snippet.len() > 16_384)
        {
            return Err(ErrorResponse::new(ErrorCode::InvalidInput));
        }
        let valid_provider = (1..=64).contains(&source.provider.len())
            && source
                .provider
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'));
        source.query = normalize_source_text(&source.query, true)?;
        if let Some(snippet) = source.snippet.as_mut() {
            *snippet = normalize_source_text(snippet, false)?;
        }
        if !valid_provider
            || !(1..=1_024).contains(&source.query.chars().count())
            || !(1..=10_000).contains(&source.rank)
            || source
                .snippet
                .as_ref()
                .is_some_and(|snippet| snippet.chars().count() > 4_096)
        {
            return Err(ErrorResponse::new(ErrorCode::InvalidInput));
        }
    }
    Ok(())
}

pub(super) fn normalize_source_text(
    value: &str,
    require_nonempty: bool,
) -> Result<String, ErrorResponse> {
    let mut output = String::with_capacity(value.len());
    let mut previous_space = false;
    for character in value.chars() {
        if matches!(character, '\n' | '\r' | '\t') {
            if !previous_space {
                output.push(' ');
                previous_space = true;
            }
        } else if character <= '\u{1f}' || ('\u{7f}'..='\u{9f}').contains(&character) {
            return Err(ErrorResponse::new(ErrorCode::InvalidInput));
        } else {
            previous_space = character.is_whitespace();
            output.push(character);
        }
    }
    let output = output.trim().to_owned();
    if require_nonempty && output.is_empty() {
        return Err(ErrorResponse::new(ErrorCode::InvalidInput));
    }
    Ok(output)
}

pub(super) fn truncate_to_characters(value: &mut String, maximum: usize) -> bool {
    let Some((byte_index, _)) = value.char_indices().nth(maximum) else {
        return false;
    };
    value.truncate(byte_index);
    true
}
