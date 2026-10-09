use regex::Regex;
use std::sync::LazyLock;

use crate::checksum;
use crate::types::{DetectionSource, EntityType, PiiSpan};

/// A compiled regex recognizer for a specific PII type.
struct Recognizer {
    pattern: &'static LazyLock<Regex>,
    entity_type: EntityType,
    base_score: f64,
}

// --- Compiled regex patterns (compiled once, reused across calls) ---

static EMAIL_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b").unwrap());

// Separators between digit groups are horizontal only: a phone number never
// continues across a line break, while tables and lists put unrelated numbers
// on consecutive lines.
static PHONE_RE: LazyLock<Regex> = LazyLock::new(|| {
    // Phones need structural cues so bare digit runs (years, IDs) don't match.
    Regex::new(concat!(
        r"(?:",
        // International with leading +: +49 30 12345678, +1-212-555-1234,
        // +442012345678, +49 (0)30 123 456-78
        r"\+\d{1,3}(?:[ \t\-./]?\(0\))?(?:[ \t\-./]?\(?\d{1,6}\)?){1,6}",
        // Parenthesized area code: (212) 555-1234, (030) 1234567
        r"|\(\d{2,5}\)[ \t\-.]?\d{2,4}(?:[ \t\-.]?\d{2,9}){1,2}",
        // National numbers with a trunk 0 (or the 00 international prefix),
        // including the German slash style: 030/12345678, 0170 / 123 45 67,
        // 0049 30 12345678
        r"|\b0\d{2,5}(?:[ \t]?/[ \t]?|[ \t\-.])\d{2,8}(?:[ \t\-.]\d{1,8}){0,3}\b",
        // Three to five groups with one consistent separator: 212-555-1234,
        // 212.555.1234, 12 345 678 901 (taken whole so no trailing group is
        // left exposed). One separator per number keeps a date and a phone
        // number written side by side ("15.01.2024 030 1234567") apart.
        r"|\b\d{2,4}(?:[ \t]\d{2,4}){1,3}[ \t]\d{2,9}\b",
        r"|\b\d{2,4}(?:-\d{2,4}){1,3}-\d{2,9}\b",
        r"|\b\d{2,4}(?:\.\d{2,4}){1,3}\.\d{2,9}\b",
        // Two groups, second one long: 030 12345678
        r"|\b\d{2,5}[ \t\-.]\d{6,12}\b",
        r")"
    ))
    .unwrap()
});

static SSN_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\b\d{3}-\d{2}-\d{4}\b").unwrap());

static CREDIT_CARD_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(concat!(
        r"(?:",
        // 16 digits, optionally in groups of four: Visa, Mastercard, ...
        r"\b(?:\d{4}[ \-]?){3}\d{4}\b",
        // 15-digit American Express, grouped 4-6-5
        r"|\b3[47]\d{2}[ \-]?\d{6}[ \-]?\d{5}\b",
        r")"
    ))
    .unwrap()
});

static IP_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\b(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\b")
        .unwrap()
});

// IBAN candidates: country code, check digits, then up to 30 alphanumerics
// that may be grouped by single spaces. Case-insensitive because people type
// IBANs in lowercase too. The pattern deliberately over-reads; every candidate
// is cut to its country's registered length and checksum-validated afterwards.
static IBAN_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\b[A-Za-z]{2}\d{2}(?:[ \u{A0}]?[A-Za-z0-9]){11,30}").unwrap());

static DATE_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(concat!(
        r"(?:",
        // DD/MM/YYYY or MM/DD/YYYY or YYYY-MM-DD
        r"\b\d{1,2}[/\-.]\d{1,2}[/\-.]\d{2,4}\b",
        r"|\b\d{4}[/\-.]\d{1,2}[/\-.]\d{1,2}\b",
        // Month DD, YYYY
        r"|\b(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2},?\s+\d{4}\b",
        // DD Month YYYY and German DD. Monat YYYY
        r"|\b\d{1,2}\.?[ \t]+(?:January|February|March|April|May|June|July|August|September|October|November|December|Januar|Jänner|Februar|März|Maerz|Mai|Juni|Juli|Oktober|Dezember|Jan|Feb|Mär|Mar|Apr|Jun|Jul|Aug|Sept?|Okt|Oct|Nov|Dez|Dec)\.?[ \t]+\d{4}\b",
        r")"
    ))
    .unwrap()
});

// Spans these recognizers produce are filtered by `accept_candidate` below.
const RECOGNIZERS: &[Recognizer] = &[
    Recognizer {
        pattern: &EMAIL_RE,
        entity_type: EntityType::Email,
        base_score: 0.95,
    },
    Recognizer {
        pattern: &PHONE_RE,
        entity_type: EntityType::Phone,
        base_score: 0.70,
    },
    Recognizer {
        pattern: &SSN_RE,
        entity_type: EntityType::Ssn,
        base_score: 0.80,
    },
    Recognizer {
        pattern: &CREDIT_CARD_RE,
        entity_type: EntityType::CreditCard,
        base_score: 0.75,
    },
    Recognizer {
        pattern: &IP_RE,
        entity_type: EntityType::IpAddress,
        base_score: 0.85,
    },
    Recognizer {
        pattern: &DATE_RE,
        entity_type: EntityType::Date,
        base_score: 0.60,
    },
];

const IBAN_BASE_SCORE: f64 = 0.80;

/// Words that, when they are the nearest label in front of a phone-shaped
/// number, say it is a document or product number rather than a phone number.
/// Deliberately limited to non-personal numbers: labels such as "Konto" or
/// "Kundennummer" are not listed, because dropping those numbers would leave
/// personal identifiers unflagged.
const NON_PHONE_LABELS: &[&str] = &[
    "invoice",
    "order",
    "ticket",
    "reference",
    "ref",
    "serial",
    "version",
    "isbn",
    "rechnung",
    "rechnungsnummer",
    "rechnungsnr",
    "bestellung",
    "bestellnummer",
    "bestellnr",
    "auftrag",
    "auftragsnummer",
    "auftragsnr",
    "referenz",
    "artikelnummer",
    "artikelnr",
    "seriennummer",
];

/// Words that mark a number as a phone number; they win over a
/// `NON_PHONE_LABELS` word that is further away.
const PHONE_LABELS: &[&str] = &[
    "phone",
    "tel",
    "telephone",
    "mobile",
    "cell",
    "fax",
    "call",
    "telefon",
    "telefonnummer",
    "handy",
    "mobil",
    "mobilnummer",
    "rufnummer",
    "festnetz",
    "whatsapp",
];

fn is_full_match(pattern: &Regex, text: &str) -> bool {
    pattern
        .find(text)
        .is_some_and(|mat| mat.start() == 0 && mat.end() == text.len())
}

fn is_group_separator(c: char) -> bool {
    matches!(c, ' ' | '\t' | '-' | '.' | '/' | '\u{A0}')
}

/// The maximal run of digit groups around `start..end`: digits, plus single
/// separators that sit between two digits.
fn digit_run(text: &str, start: usize, end: usize) -> (usize, usize) {
    let mut run_start = start;
    loop {
        let mut before = text[..run_start].chars().rev();
        match before.next() {
            Some(c) if c.is_ascii_digit() => run_start -= 1,
            Some(c) if is_group_separator(c) => match before.next() {
                Some(d) if d.is_ascii_digit() => run_start -= c.len_utf8(),
                _ => break,
            },
            _ => break,
        }
    }

    let mut run_end = end;
    loop {
        let mut after = text[run_end..].chars();
        match after.next() {
            Some(c) if c.is_ascii_digit() => run_end += 1,
            Some(c) if is_group_separator(c) => match after.next() {
                Some(d) if d.is_ascii_digit() => run_end += c.len_utf8(),
                _ => break,
            },
            _ => break,
        }
    }

    (run_start, run_end)
}

/// Rejects number-shaped candidates (phone, card) that are only a fragment of
/// a longer identifier, for example the digit groups of an IBAN such as
/// `DE89 3704 0044 0532 0130 00` or `de89 …`, an order code such as
/// `AB12 3456 7890`, or a 20+ digit reference.
fn is_fragment_of_longer_identifier(text: &str, start: usize, end: usize) -> bool {
    if !text[start..end].starts_with(|c: char| c.is_ascii_digit()) {
        return false;
    }

    let (run_start, run_end) = digit_run(text, start, end);
    let glued_left = text[..run_start]
        .chars()
        .next_back()
        .is_some_and(char::is_alphabetic);
    let glued_right = text[run_end..]
        .chars()
        .next()
        .is_some_and(char::is_alphabetic);
    if glued_left || glued_right {
        return true;
    }

    let digits = text[run_start..run_end]
        .chars()
        .filter(char::is_ascii_digit)
        .count();
    digits > 19
}

/// Four or more groups of exactly four digits (`1234 5678 9012 3456`) is
/// card/account formatting, never a phone number.
fn is_inside_four_digit_block_run(text: &str, start: usize, end: usize) -> bool {
    let (run_start, run_end) = digit_run(text, start, end);
    let groups: Vec<&str> = text[run_start..run_end].split(is_group_separator).collect();
    groups.len() >= 4 && groups.iter().all(|group| group.len() == 4)
}

/// `12.500.000` — dot-grouped thousands, an amount rather than a phone number.
fn is_thousands_grouped_number(candidate: &str) -> bool {
    let groups: Vec<&str> = candidate.split('.').collect();
    groups.len() >= 3
        && groups.iter().all(|g| g.chars().all(|c| c.is_ascii_digit()))
        && (1..=3).contains(&groups[0].len())
        && groups[1..].iter().all(|g| g.len() == 3)
}

fn significant_phone_digits(candidate: &str) -> usize {
    // A "(0)" trunk prefix after the country code is not dialed.
    candidate
        .replace("(0)", "")
        .chars()
        .filter(char::is_ascii_digit)
        .count()
}

/// Trim trailing digit groups from an international number until it fits the
/// E.164 maximum of 15 digits, so a following year or count is not swallowed.
fn trim_international_phone(candidate: &str) -> &str {
    let mut end = candidate.len();
    while significant_phone_digits(&candidate[..end]) > 15 {
        match candidate[..end].rfind(|c: char| is_group_separator(c) || c == '(' || c == ')') {
            Some(idx) if idx > 0 => end = idx,
            _ => return "",
        }
        end = candidate[..end]
            .trim_end_matches(|c: char| !c.is_ascii_digit())
            .len();
    }
    &candidate[..end]
}

/// The nearest label word in front of `start` (looking back at most three
/// words) decides whether a phone-shaped number is actually some other number.
fn has_non_phone_label(text: &str, start: usize) -> bool {
    let words = text[..start]
        .split(|c: char| !(c.is_alphanumeric() || c == '-'))
        .filter(|word| !word.is_empty() && !word.chars().all(|c| c.is_ascii_digit() || c == '-'))
        .rev()
        .take(3);

    for word in words {
        let word = word.trim_matches('-').to_lowercase();
        if PHONE_LABELS.contains(&word.as_str()) {
            return false;
        }
        if NON_PHONE_LABELS.contains(&word.as_str()) {
            return true;
        }
    }
    false
}

fn accept_phone(text: &str, start: usize, end: usize) -> bool {
    let candidate = &text[start..end];
    let digits = significant_phone_digits(candidate);
    !(!(7..=15).contains(&digits)
        || is_full_match(&DATE_RE, candidate)
        || is_thousands_grouped_number(candidate)
        || is_fragment_of_longer_identifier(text, start, end)
        || is_inside_four_digit_block_run(text, start, end)
        || (!candidate.starts_with('+') && has_non_phone_label(text, start)))
}

/// A dotted quad that is part of a longer dotted number (`1.2.3.4.5`, an OID
/// or version) is not an IP address.
fn is_part_of_longer_dotted_number(text: &str, start: usize, end: usize) -> bool {
    let before = &text.as_bytes()[..start];
    let after = &text.as_bytes()[end..];
    let dotted_before = before.len() >= 2
        && before[before.len() - 1] == b'.'
        && before[before.len() - 2].is_ascii_digit();
    let dotted_after = after.len() >= 2 && after[0] == b'.' && after[1].is_ascii_digit();
    dotted_before || dotted_after
}

/// Recognizer-specific structural checks that need the surrounding text.
/// Checksums that only need the span itself live in `checksum::validate`.
fn accept_candidate(entity_type: EntityType, text: &str, start: usize, end: usize) -> bool {
    match entity_type {
        EntityType::Phone => accept_phone(text, start, end),
        EntityType::CreditCard => !is_fragment_of_longer_identifier(text, start, end),
        EntityType::IpAddress => !is_part_of_longer_dotted_number(text, start, end),
        _ => true,
    }
}

/// Byte ranges of IBAN-shaped tokens: a known country code followed by
/// exactly that country's registered number of characters, optionally
/// grouped by spaces. The check digits are not verified here.
pub fn iban_shaped_ranges(text: &str) -> Vec<(usize, usize)> {
    let mut ranges = Vec::new();
    let mut search_from = 0;
    while let Some(mat) = IBAN_RE.find_at(text, search_from) {
        match iban_end(text, mat.start(), mat.end()) {
            Some(end) => {
                ranges.push((mat.start(), end));
                search_from = end;
            }
            None => {
                // Resume right after the first character so an IBAN that the
                // over-reading candidate swallowed can still be found.
                let first_len = text[mat.start()..].chars().next().map_or(1, char::len_utf8);
                search_from = mat.start() + first_len;
            }
        }
    }
    ranges
}

/// IBAN candidates; checksum validation happens in the pipeline's checksum
/// stage.
fn detect_ibans(text: &str, spans: &mut Vec<PiiSpan>) {
    for (start, end) in iban_shaped_ranges(text) {
        spans.push(PiiSpan::new(
            start,
            end,
            EntityType::Iban,
            IBAN_BASE_SCORE,
            text[start..end].to_string(),
            DetectionSource::Regex,
        ));
    }
}

fn iban_end(text: &str, start: usize, candidate_end: usize) -> Option<usize> {
    let candidate = &text[start..candidate_end];
    let expected_len = checksum::iban_length_for_country(&candidate[..2])?;

    let mut alnum_count = 0;
    for (idx, c) in candidate.char_indices() {
        if c.is_ascii_alphanumeric() {
            alnum_count += 1;
            if alnum_count == expected_len {
                let end = start + idx + 1;
                let ends_token = !text[end..]
                    .chars()
                    .next()
                    .is_some_and(|next| next.is_alphanumeric());
                return ends_token.then_some(end);
            }
        }
    }
    None
}

/// Run all regex recognizers against the input text.
/// Returns candidate PII spans with their type and base confidence score.
pub fn detect_regex(text: &str) -> Vec<PiiSpan> {
    let mut spans = Vec::new();

    for recognizer in RECOGNIZERS {
        for mat in recognizer.pattern.find_iter(text) {
            let (start, mut end) = (mat.start(), mat.end());
            if recognizer.entity_type == EntityType::Phone && mat.as_str().starts_with('+') {
                end = start + trim_international_phone(mat.as_str()).len();
                if end == start {
                    continue;
                }
            }

            if !accept_candidate(recognizer.entity_type, text, start, end) {
                continue;
            }

            spans.push(PiiSpan::new(
                start,
                end,
                recognizer.entity_type,
                recognizer.base_score,
                text[start..end].to_string(),
                DetectionSource::Regex,
            ));
        }
    }

    detect_ibans(text, &mut spans);

    spans
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_email_detection() {
        let spans = detect_regex("Contact me at john.doe@example.com please");
        assert_eq!(spans.len(), 1);
        assert_eq!(spans[0].entity_type, EntityType::Email);
        assert_eq!(spans[0].text, "john.doe@example.com");
    }

    #[test]
    fn test_multiple_emails() {
        let spans = detect_regex("Send to a@b.com and c@d.org");
        let emails: Vec<_> = spans
            .iter()
            .filter(|s| s.entity_type == EntityType::Email)
            .collect();
        assert_eq!(emails.len(), 2);
    }

    #[test]
    fn test_phone_us_format() {
        let spans = detect_regex("Call 212-555-1234");
        let phones: Vec<_> = spans
            .iter()
            .filter(|s| s.entity_type == EntityType::Phone)
            .collect();
        assert!(phones.len() >= 1);
        assert!(phones[0].text.contains("212"));
    }

    #[test]
    fn test_phone_international() {
        let spans = detect_regex("Call +49 30 12345678");
        let phones: Vec<_> = spans
            .iter()
            .filter(|s| s.entity_type == EntityType::Phone)
            .collect();
        assert!(phones.len() >= 1);
    }

    #[test]
    fn test_german_numeric_date_is_not_phone() {
        let spans = detect_regex("Geburtsdatum 15.01.1990");
        let phones: Vec<_> = spans
            .iter()
            .filter(|s| s.entity_type == EntityType::Phone)
            .collect();
        let dates: Vec<_> = spans
            .iter()
            .filter(|s| s.entity_type == EntityType::Date)
            .collect();

        assert!(phones.is_empty());
        assert_eq!(dates.len(), 1);
        assert_eq!(dates[0].text, "15.01.1990");
    }

    #[test]
    fn test_year_numbers_are_not_phones() {
        let texts = [
            "Born in 1990",
            "Released in 2023",
            "between 2020 and 2024",
            "page 12345",
            "order 1234567",
        ];
        for text in texts {
            let phones: Vec<_> = detect_regex(text)
                .into_iter()
                .filter(|s| s.entity_type == EntityType::Phone)
                .collect();
            assert!(
                phones.is_empty(),
                "expected no phones in {text:?}, got {phones:?}"
            );
        }
    }

    #[test]
    fn test_ssn() {
        let spans = detect_regex("SSN: 123-45-6789");
        let ssns: Vec<_> = spans
            .iter()
            .filter(|s| s.entity_type == EntityType::Ssn)
            .collect();
        assert_eq!(ssns.len(), 1);
        assert_eq!(ssns[0].text, "123-45-6789");
    }

    #[test]
    fn test_credit_card() {
        let spans = detect_regex("Card: 4111-1111-1111-1111");
        let ccs: Vec<_> = spans
            .iter()
            .filter(|s| s.entity_type == EntityType::CreditCard)
            .collect();
        assert_eq!(ccs.len(), 1);
    }

    #[test]
    fn test_credit_card_spaces() {
        let spans = detect_regex("Card: 4111 1111 1111 1111");
        let ccs: Vec<_> = spans
            .iter()
            .filter(|s| s.entity_type == EntityType::CreditCard)
            .collect();
        assert_eq!(ccs.len(), 1);
    }

    #[test]
    fn test_ip_address() {
        let spans = detect_regex("Server at 192.168.1.1 is down");
        let ips: Vec<_> = spans
            .iter()
            .filter(|s| s.entity_type == EntityType::IpAddress)
            .collect();
        assert_eq!(ips.len(), 1);
        assert_eq!(ips[0].text, "192.168.1.1");
    }

    #[test]
    fn test_ip_address_invalid_octets() {
        // 999.999.999.999 should not match the IP pattern
        let spans = detect_regex("Address 999.999.999.999");
        let ips: Vec<_> = spans
            .iter()
            .filter(|s| s.entity_type == EntityType::IpAddress)
            .collect();
        assert_eq!(ips.len(), 0);
    }

    #[test]
    fn test_iban() {
        let spans = detect_regex("IBAN: DE89370400440532013000");
        let ibans: Vec<_> = spans
            .iter()
            .filter(|s| s.entity_type == EntityType::Iban)
            .collect();
        assert_eq!(ibans.len(), 1);
    }

    #[test]
    fn test_date_iso() {
        let spans = detect_regex("Born on 1990-01-15");
        let dates: Vec<_> = spans
            .iter()
            .filter(|s| s.entity_type == EntityType::Date)
            .collect();
        assert!(dates.len() >= 1);
    }

    #[test]
    fn test_date_written() {
        let spans = detect_regex("Born on January 15, 2024");
        let dates: Vec<_> = spans
            .iter()
            .filter(|s| s.entity_type == EntityType::Date)
            .collect();
        assert!(dates.len() >= 1);
    }

    #[test]
    fn test_no_pii() {
        let spans = detect_regex("What is the weather today?");
        assert!(spans.is_empty());
    }

    #[test]
    fn test_empty_input() {
        let spans = detect_regex("");
        assert!(spans.is_empty());
    }

    #[test]
    fn test_mixed_pii() {
        let text = "Hi, my name is David and my email is david@corp.com. Call me at 212-555-1234.";
        let spans = detect_regex(text);
        let types: Vec<_> = spans.iter().map(|s| s.entity_type).collect();
        assert!(types.contains(&EntityType::Email));
        assert!(types.contains(&EntityType::Phone));
    }

    #[test]
    fn test_partial_email_no_match() {
        let spans = detect_regex("not-an-email@");
        let emails: Vec<_> = spans
            .iter()
            .filter(|s| s.entity_type == EntityType::Email)
            .collect();
        assert_eq!(emails.len(), 0);
    }

    fn texts_of(text: &str, entity_type: EntityType) -> Vec<String> {
        detect_regex(text)
            .into_iter()
            .filter(|s| s.entity_type == entity_type)
            .map(|s| s.text)
            .collect()
    }

    #[test]
    fn test_iban_spaced_and_lowercase_candidates() {
        assert_eq!(
            texts_of("IBAN: DE89 3704 0044 0532 0130 00.", EntityType::Iban),
            vec!["DE89 3704 0044 0532 0130 00"]
        );
        assert_eq!(
            texts_of("iban de89370400440532013000", EntityType::Iban),
            vec!["de89370400440532013000"]
        );
    }

    #[test]
    fn test_iban_candidate_is_cut_to_country_length() {
        // The pattern over-reads into "BIC"; the candidate is cut back to the
        // 22 characters of a German IBAN.
        assert_eq!(
            texts_of("DE89370400440532013000 BIC COBADEFFXXX", EntityType::Iban),
            vec!["DE89370400440532013000"]
        );
    }

    #[test]
    fn test_iban_candidate_too_long_for_country_is_dropped() {
        assert!(texts_of("DE893704004405320130001", EntityType::Iban).is_empty());
    }

    #[test]
    fn test_no_phone_fragments_inside_iban_digit_groups() {
        for text in [
            "DE89 3704 0044 0532 0130 00",
            "de89 3704 0044 0532 0130 00",
            "DE12 3456 7890 1234 5678 90",
            "AT61 1904 3002 3457 3201",
        ] {
            assert!(texts_of(text, EntityType::Phone).is_empty(), "{text}");
            assert!(texts_of(text, EntityType::CreditCard).is_empty(), "{text}");
        }
    }

    #[test]
    fn test_phone_slash_and_trunk_prefix_formats() {
        assert_eq!(
            texts_of("Tel. 030/12345678", EntityType::Phone),
            vec!["030/12345678"]
        );
        assert_eq!(
            texts_of("Tel 0170 / 123 45 67", EntityType::Phone),
            vec!["0170 / 123 45 67"]
        );
        assert_eq!(
            texts_of("Tel +49 (0)30 123 456 78", EntityType::Phone),
            vec!["+49 (0)30 123 456 78"]
        );
    }

    #[test]
    fn test_phone_does_not_cross_line_breaks() {
        assert_eq!(
            texts_of("Tel 030 1234567\n2024 Bericht", EntityType::Phone),
            vec!["030 1234567"]
        );
        assert!(texts_of("12\n345\n6789", EntityType::Phone).is_empty());
    }

    #[test]
    fn test_phone_rejects_thousands_grouped_amounts() {
        assert!(texts_of("Umsatz 12.500.000 EUR", EntityType::Phone).is_empty());
        assert!(texts_of("1.000.000", EntityType::Phone).is_empty());
    }

    #[test]
    fn test_phone_rejects_four_digit_block_numbers() {
        assert!(texts_of("1234 5678 9012 3456", EntityType::Phone).is_empty());
    }

    #[test]
    fn test_phone_rejects_document_number_labels() {
        assert!(texts_of("Rechnungsnr. 2024-001-12345", EntityType::Phone).is_empty());
        assert!(texts_of("Order 123-456-7890", EntityType::Phone).is_empty());
        // An explicit international number is a phone whatever the label.
        assert_eq!(
            texts_of("Order hotline +49 30 12345678", EntityType::Phone),
            vec!["+49 30 12345678"]
        );
    }

    #[test]
    fn test_phone_keeps_personal_number_labels() {
        // Customer/account numbers are personal; they are not dropped.
        assert_eq!(
            texts_of("Kundennummer 123 456 789", EntityType::Phone),
            vec!["123 456 789"]
        );
    }

    #[test]
    fn test_phone_requires_seven_to_fifteen_digits() {
        assert!(texts_of("Raum 12 34 56", EntityType::Phone).is_empty());
        assert_eq!(
            texts_of("+49 30 12345678 2024", EntityType::Phone),
            vec!["+49 30 12345678"]
        );
    }

    #[test]
    fn test_credit_card_amex_grouping() {
        assert_eq!(
            texts_of("Amex 3782 822463 10005", EntityType::CreditCard),
            vec!["3782 822463 10005"]
        );
    }

    #[test]
    fn test_ip_inside_longer_dotted_number_is_rejected() {
        assert!(texts_of("OID 1.2.3.4.5", EntityType::IpAddress).is_empty());
        assert_eq!(
            texts_of("Host 10.0.0.5.", EntityType::IpAddress),
            vec!["10.0.0.5"]
        );
    }

    #[test]
    fn test_written_dates_german_and_day_first() {
        assert_eq!(
            texts_of("am 15. März 1990", EntityType::Date),
            vec!["15. März 1990"]
        );
        assert_eq!(
            texts_of("am 1. Okt. 2023", EntityType::Date),
            vec!["1. Okt. 2023"]
        );
        assert_eq!(
            texts_of("on 15 January 2024", EntityType::Date),
            vec!["15 January 2024"]
        );
    }
}
