use crate::types::{EntityType, PiiSpan};

/// Validate a PII span using checksum algorithms where applicable.
/// Returns true if the span passes validation (or if no validation applies).
pub fn validate(span: &PiiSpan) -> bool {
    match span.entity_type {
        EntityType::CreditCard => validate_luhn(&span.text),
        EntityType::Iban => validate_iban(&span.text),
        EntityType::Ssn => validate_ssn_format(&span.text),
        EntityType::Date => validate_date(&span.text),
        // No checksum for other types — pass through
        _ => true,
    }
}

/// Luhn algorithm for credit card number validation.
/// Strips non-digit characters before validation.
fn validate_luhn(text: &str) -> bool {
    let digits: Vec<u32> = text.chars().filter_map(|c| c.to_digit(10)).collect();

    if digits.len() < 13 || digits.len() > 19 {
        return false;
    }

    // No card network issues numbers starting with 0, and a run of one
    // repeated digit (`0000 0000 0000 0000`) passes Luhn trivially.
    if digits[0] == 0 || digits.iter().all(|&d| d == digits[0]) {
        return false;
    }

    let mut sum = 0u32;
    let mut double = false;

    for &digit in digits.iter().rev() {
        let mut d = digit;
        if double {
            d *= 2;
            if d > 9 {
                d -= 9;
            }
        }
        sum += d;
        double = !double;
    }

    sum % 10 == 0
}

/// Registered IBAN length per country (SWIFT IBAN registry).
#[rustfmt::skip]
const IBAN_LENGTHS: &[(&str, usize)] = &[
    ("AD", 24), ("AE", 23), ("AL", 28), ("AT", 20), ("AZ", 28), ("BA", 20), ("BE", 16),
    ("BG", 22), ("BH", 22), ("BI", 27), ("BR", 29), ("BY", 28), ("CH", 21), ("CR", 22),
    ("CY", 28), ("CZ", 24), ("DE", 22), ("DJ", 27), ("DK", 18), ("DO", 28), ("EE", 20),
    ("EG", 29), ("ES", 24), ("FI", 18), ("FK", 18), ("FO", 18), ("FR", 27), ("GB", 22),
    ("GE", 22), ("GI", 23), ("GL", 18), ("GR", 27), ("GT", 28), ("HR", 21), ("HU", 28),
    ("IE", 22), ("IL", 23), ("IQ", 23), ("IS", 26), ("IT", 27), ("JO", 30), ("KW", 30),
    ("KZ", 20), ("LB", 28), ("LC", 32), ("LI", 21), ("LT", 20), ("LU", 20), ("LV", 21),
    ("LY", 25), ("MC", 27), ("MD", 24), ("ME", 22), ("MK", 19), ("MN", 20), ("MR", 27),
    ("MT", 31), ("MU", 30), ("NI", 28), ("NL", 18), ("NO", 15), ("OM", 23), ("PK", 24),
    ("PL", 28), ("PS", 29), ("PT", 25), ("QA", 29), ("RO", 24), ("RS", 22), ("RU", 33),
    ("SA", 24), ("SC", 31), ("SD", 18), ("SE", 24), ("SI", 19), ("SK", 24), ("SM", 27),
    ("SO", 23), ("ST", 25), ("SV", 28), ("TL", 23), ("TN", 24), ("TR", 26), ("UA", 29),
    ("VA", 22), ("VG", 24), ("XK", 20), ("YE", 30),
];

/// The registered IBAN length for a two-letter country code (any case).
pub fn iban_length_for_country(country: &str) -> Option<usize> {
    IBAN_LENGTHS
        .iter()
        .find(|(code, _)| code.eq_ignore_ascii_case(country))
        .map(|&(_, len)| len)
}

/// IBAN check digit validation (ISO 13616).
/// Checks the country's registered length, then rearranges the IBAN and
/// computes mod 97. Case-insensitive; whitespace (including no-break spaces)
/// is ignored.
fn validate_iban(text: &str) -> bool {
    let cleaned: String = text
        .chars()
        .filter(|c| !c.is_whitespace())
        .collect::<String>()
        .to_ascii_uppercase();

    if cleaned.len() < 5 || cleaned.len() > 34 || !cleaned.is_ascii() {
        return false;
    }

    if iban_length_for_country(&cleaned[..2]) != Some(cleaned.len()) {
        return false;
    }

    // First two must be letters, next two must be digits
    let chars: Vec<char> = cleaned.chars().collect();
    if !chars[0].is_ascii_uppercase()
        || !chars[1].is_ascii_uppercase()
        || !chars[2].is_ascii_digit()
        || !chars[3].is_ascii_digit()
    {
        return false;
    }

    // Move first 4 chars to end
    let rearranged = format!("{}{}", &cleaned[4..], &cleaned[..4]);

    // Convert letters to numbers (A=10, B=11, ..., Z=35)
    let mut numeric = String::new();
    for c in rearranged.chars() {
        if c.is_ascii_digit() {
            numeric.push(c);
        } else if c.is_ascii_uppercase() {
            let val = (c as u32) - ('A' as u32) + 10;
            numeric.push_str(&val.to_string());
        } else {
            return false;
        }
    }

    // Compute mod 97 using chunked arithmetic to avoid overflow
    mod97(&numeric) == 1
}

/// Compute number mod 97 from a decimal string, using chunked processing.
fn mod97(s: &str) -> u64 {
    let mut remainder: u64 = 0;
    for chunk in s.as_bytes().chunks(9) {
        let chunk_str = std::str::from_utf8(chunk).unwrap_or("0");
        let combined = format!("{}{}", remainder, chunk_str);
        remainder = combined.parse::<u64>().unwrap_or(0) % 97;
    }
    remainder
}

/// Plausibility check for numeric dates: day 1-31, month 1-12 (day-first or
/// month-first), a two- or four-digit year, and one separator used
/// throughout. Written-out dates (`15. März 1990`) pass through.
fn validate_date(text: &str) -> bool {
    if text.chars().any(char::is_alphabetic) {
        return true;
    }
    let Some(separator) = text.chars().find(|c| matches!(c, '/' | '-' | '.')) else {
        return false;
    };

    let parts: Vec<&str> = text.split(separator).collect();
    if parts.len() != 3
        || parts
            .iter()
            .any(|p| p.is_empty() || !p.chars().all(|c| c.is_ascii_digit()))
    {
        return false;
    }
    let numbers: Vec<u32> = parts.iter().filter_map(|p| p.parse().ok()).collect();
    if numbers.len() != 3 {
        return false;
    }

    let is_day = |n: u32| (1..=31).contains(&n);
    let is_month = |n: u32| (1..=12).contains(&n);

    if parts[0].len() == 4 {
        // YYYY-MM-DD
        return is_month(numbers[1]) && is_day(numbers[2]);
    }

    let year_ok = matches!(parts[2].len(), 2 | 4);
    let day_month = is_day(numbers[0]) && is_month(numbers[1]);
    let month_day = is_month(numbers[0]) && is_day(numbers[1]);
    year_ok && (day_month || month_day)
}

/// Validate SSN format: XXX-XX-XXXX with additional rules.
/// Area number (first 3) cannot be 000, 666, or 900-999.
/// Group number (middle 2) cannot be 00.
/// Serial number (last 4) cannot be 0000.
fn validate_ssn_format(text: &str) -> bool {
    let parts: Vec<&str> = text.split('-').collect();
    if parts.len() != 3 {
        return false;
    }

    let area: u32 = match parts[0].parse() {
        Ok(n) => n,
        Err(_) => return false,
    };
    let group: u32 = match parts[1].parse() {
        Ok(n) => n,
        Err(_) => return false,
    };
    let serial: u32 = match parts[2].parse() {
        Ok(n) => n,
        Err(_) => return false,
    };

    if area == 0 || area == 666 || area >= 900 {
        return false;
    }
    if group == 0 {
        return false;
    }
    if serial == 0 {
        return false;
    }

    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::DetectionSource;

    fn make_span(text: &str, entity_type: EntityType) -> PiiSpan {
        PiiSpan::new(
            0,
            text.len(),
            entity_type,
            0.9,
            text.to_string(),
            DetectionSource::Regex,
        )
    }

    // --- Luhn tests ---

    #[test]
    fn test_luhn_valid_visa() {
        assert!(validate_luhn("4111111111111111"));
    }

    #[test]
    fn test_luhn_valid_with_separators() {
        assert!(validate_luhn("4111-1111-1111-1111"));
    }

    #[test]
    fn test_luhn_valid_with_spaces() {
        assert!(validate_luhn("4111 1111 1111 1111"));
    }

    #[test]
    fn test_luhn_invalid() {
        assert!(!validate_luhn("4111111111111112"));
    }

    #[test]
    fn test_luhn_too_short() {
        assert!(!validate_luhn("411111"));
    }

    #[test]
    fn test_luhn_valid_mastercard() {
        assert!(validate_luhn("5500000000000004"));
    }

    // --- IBAN tests ---

    #[test]
    fn test_iban_valid_german() {
        assert!(validate_iban("DE89370400440532013000"));
    }

    #[test]
    fn test_iban_valid_with_spaces() {
        assert!(validate_iban("DE89 3704 0044 0532 0130 00"));
    }

    #[test]
    fn test_iban_valid_british() {
        assert!(validate_iban("GB29NWBK60161331926819"));
    }

    #[test]
    fn test_iban_invalid_checksum() {
        assert!(!validate_iban("DE00370400440532013000"));
    }

    #[test]
    fn test_iban_too_short() {
        assert!(!validate_iban("DE89"));
    }

    // --- SSN tests ---

    #[test]
    fn test_ssn_valid() {
        assert!(validate_ssn_format("123-45-6789"));
    }

    #[test]
    fn test_ssn_invalid_area_000() {
        assert!(!validate_ssn_format("000-45-6789"));
    }

    #[test]
    fn test_ssn_invalid_area_666() {
        assert!(!validate_ssn_format("666-45-6789"));
    }

    #[test]
    fn test_ssn_invalid_area_900plus() {
        assert!(!validate_ssn_format("900-45-6789"));
    }

    #[test]
    fn test_ssn_invalid_group_00() {
        assert!(!validate_ssn_format("123-00-6789"));
    }

    #[test]
    fn test_ssn_invalid_serial_0000() {
        assert!(!validate_ssn_format("123-45-0000"));
    }

    // --- Integration via validate() ---

    #[test]
    fn test_validate_cc_valid() {
        let span = make_span("4111-1111-1111-1111", EntityType::CreditCard);
        assert!(validate(&span));
    }

    #[test]
    fn test_validate_cc_invalid() {
        let span = make_span("1234-5678-9012-3456", EntityType::CreditCard);
        assert!(!validate(&span));
    }

    #[test]
    fn test_validate_email_passthrough() {
        let span = make_span("test@example.com", EntityType::Email);
        assert!(validate(&span)); // no checksum for email
    }

    #[test]
    fn test_validate_iban_valid() {
        let span = make_span("DE89370400440532013000", EntityType::Iban);
        assert!(validate(&span));
    }

    #[test]
    fn test_validate_ssn_valid() {
        let span = make_span("123-45-6789", EntityType::Ssn);
        assert!(validate(&span));
    }

    #[test]
    fn test_luhn_rejects_leading_zero_and_repeated_digit_numbers() {
        // Both pass the bare Luhn sum.
        assert!(!validate_luhn("0000 0000 0000 0000"));
        assert!(!validate_luhn("0000000000000018"));
    }

    #[test]
    fn test_luhn_accepts_amex() {
        assert!(validate_luhn("3782 822463 10005"));
    }

    #[test]
    fn test_iban_is_case_insensitive() {
        assert!(validate_iban("de89 3704 0044 0532 0130 00"));
        assert!(validate_iban("gb29nwbk60161331926819"));
    }

    #[test]
    fn test_iban_valid_other_countries() {
        for iban in [
            "AT61 1904 3002 3457 3201",
            "CH93 0076 2011 6238 5295 7",
            "NL91 ABNA 0417 1643 00",
            "FR14 2004 1010 0505 0001 3M02 606",
            "BE68 5390 0754 7034",
            "NO93 8601 1117 947",
        ] {
            assert!(validate_iban(iban), "{iban}");
        }
    }

    #[test]
    fn test_iban_ignores_no_break_spaces() {
        assert!(validate_iban(
            "DE89\u{A0}3704\u{A0}0044\u{A0}0532\u{A0}0130\u{A0}00"
        ));
    }

    #[test]
    fn test_iban_rejects_wrong_length_for_country() {
        // Valid mod-97 for the digits, but Germany's IBANs have 22 characters.
        assert!(!validate_iban("DE5137040044053201300"));
        // Unknown country code.
        assert!(!validate_iban("XX89370400440532013000"));
    }

    #[test]
    fn test_iban_length_for_country() {
        assert_eq!(iban_length_for_country("DE"), Some(22));
        assert_eq!(iban_length_for_country("at"), Some(20));
        assert_eq!(iban_length_for_country("NO"), Some(15));
        assert_eq!(iban_length_for_country("ZZ"), None);
    }

    // --- Date tests ---

    #[test]
    fn test_date_accepts_plausible_numeric_dates() {
        for date in [
            "15.01.1990",
            "01/31/2024",
            "1990-01-15",
            "3.5.24",
            "12-31-1999",
        ] {
            assert!(validate_date(date), "{date}");
        }
    }

    #[test]
    fn test_date_rejects_implausible_numeric_dates() {
        for date in [
            "45.67.2024",
            "2024-13-01",
            "2024-01-32",
            "00.01.2024",
            "1.2.123",
            "12.03/2024",
        ] {
            assert!(!validate_date(date), "{date}");
        }
    }

    #[test]
    fn test_date_written_forms_pass_through() {
        assert!(validate_date("15. März 1990"));
        assert!(validate_date("January 15, 2024"));
    }
}
