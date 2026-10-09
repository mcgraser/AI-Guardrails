use crate::types::{DetectionSource, EntityType, PiiSpan};

use std::cmp::Ordering;

/// Merge overlapping PII spans, keeping authoritative structured detections
/// ahead of weaker overlapping guesses.
///
/// Algorithm:
/// 1. Rank every span by precedence (source and how strongly its type is
///    validated), then score, then length.
/// 2. Accept spans in rank order, skipping any span that overlaps one already
///    accepted.
/// 3. Return the accepted spans in text order.
///
/// Ranking globally (instead of only against the previous span in text
/// order) matters for structured data: a checksum-validated IBAN must beat
/// the phone-shaped digit groups inside it, even when a nearby "Tel" boosts
/// the phone fragment's score above the IBAN's.
pub fn merge_spans(mut spans: Vec<PiiSpan>) -> Vec<PiiSpan> {
    if spans.len() <= 1 {
        return spans;
    }

    spans.sort_by(rank);

    let mut merged: Vec<PiiSpan> = Vec::with_capacity(spans.len());
    for span in spans {
        if !merged.iter().any(|accepted| accepted.overlaps(&span)) {
            merged.push(span);
        }
    }

    merged.sort_by_key(|span| (span.start, span.end));
    merged
}

/// Best span first.
fn rank(a: &PiiSpan, b: &PiiSpan) -> Ordering {
    precedence(b)
        .cmp(&precedence(a))
        .then(b.score.partial_cmp(&a.score).unwrap_or(Ordering::Equal))
        .then((b.end - b.start).cmp(&(a.end - a.start)))
        .then(a.start.cmp(&b.start))
}

fn precedence(span: &PiiSpan) -> u8 {
    match span.source {
        DetectionSource::Manual => 10,
        DetectionSource::Regex => structured_type_precedence(span.entity_type),
        DetectionSource::Ner => 1,
    }
}

/// How much a regex detection of this type can be trusted over an
/// overlapping one. Every structured regex type outranks NER (1).
fn structured_type_precedence(entity_type: EntityType) -> u8 {
    match entity_type {
        // Checksum-validated (mod-97, Luhn): the strongest evidence.
        EntityType::Iban | EntityType::CreditCard => 6,
        // Unambiguous syntax.
        EntityType::Email => 5,
        // Fixed shapes with range/format validation.
        EntityType::IpAddress | EntityType::Ssn => 4,
        // Loose digit-group heuristics; the most likely to be a fragment of
        // something else.
        EntityType::Phone => 3,
        EntityType::Date => 2,
        _ => 1,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn span(start: usize, end: usize, score: f64, entity_type: EntityType) -> PiiSpan {
        PiiSpan::new(
            start,
            end,
            entity_type,
            score,
            format!("[{}-{}]", start, end),
            DetectionSource::Regex,
        )
    }

    fn sourced_span(
        start: usize,
        end: usize,
        score: f64,
        entity_type: EntityType,
        source: DetectionSource,
    ) -> PiiSpan {
        PiiSpan::new(
            start,
            end,
            entity_type,
            score,
            format!("[{}-{}]", start, end),
            source,
        )
    }

    #[test]
    fn test_no_overlap() {
        let spans = vec![
            span(0, 5, 0.9, EntityType::Person),
            span(10, 15, 0.8, EntityType::Email),
        ];
        let result = merge_spans(spans);
        assert_eq!(result.len(), 2);
    }

    #[test]
    fn test_full_overlap_keep_higher_score() {
        let spans = vec![
            span(0, 10, 0.9, EntityType::Person),
            span(0, 10, 0.7, EntityType::Organization),
        ];
        let result = merge_spans(spans);
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].entity_type, EntityType::Person);
        assert!((result[0].score - 0.9).abs() < 0.01);
    }

    #[test]
    fn test_partial_overlap_keep_higher_score() {
        let spans = vec![
            span(0, 10, 0.7, EntityType::Person),
            span(5, 15, 0.9, EntityType::Organization),
        ];
        let result = merge_spans(spans);
        assert_eq!(result.len(), 1);
        // The higher-scoring span should win
        assert!((result[0].score - 0.9).abs() < 0.01);
    }

    #[test]
    fn test_adjacent_no_overlap() {
        let spans = vec![
            span(0, 5, 0.9, EntityType::Person),
            span(5, 10, 0.8, EntityType::Email),
        ];
        let result = merge_spans(spans);
        assert_eq!(result.len(), 2); // adjacent, not overlapping
    }

    #[test]
    fn test_empty() {
        let result = merge_spans(vec![]);
        assert!(result.is_empty());
    }

    #[test]
    fn test_single_span() {
        let spans = vec![span(0, 10, 0.9, EntityType::Person)];
        let result = merge_spans(spans);
        assert_eq!(result.len(), 1);
    }

    #[test]
    fn test_three_way_overlap() {
        let spans = vec![
            span(0, 10, 0.5, EntityType::Person),
            span(3, 12, 0.9, EntityType::Organization),
            span(8, 15, 0.7, EntityType::Location),
        ];
        let result = merge_spans(spans);
        // First span at 0-10 (0.5) overlaps with 3-12 (0.9) → keep 0.9 at 3-12
        // Then 3-12 overlaps with 8-15 → keep 0.9 at 3-12
        assert_eq!(result.len(), 1);
        assert!((result[0].score - 0.9).abs() < 0.01);
    }

    #[test]
    fn test_mixed_overlapping_and_not() {
        let spans = vec![
            span(0, 5, 0.9, EntityType::Person),
            span(3, 8, 0.7, EntityType::Organization),
            span(20, 30, 0.8, EntityType::Email),
            span(25, 35, 0.6, EntityType::Phone),
        ];
        let result = merge_spans(spans);
        assert_eq!(result.len(), 2);
        assert_eq!(result[0].entity_type, EntityType::Person);
        assert_eq!(result[1].entity_type, EntityType::Email);
    }

    #[test]
    fn structured_regex_beats_higher_scoring_overlapping_ner() {
        let spans = vec![
            sourced_span(0, 19, 0.99, EntityType::BankAccount, DetectionSource::Ner),
            sourced_span(3, 19, 0.75, EntityType::CreditCard, DetectionSource::Regex),
        ];

        let result = merge_spans(spans);

        assert_eq!(result.len(), 1);
        assert_eq!(result[0].entity_type, EntityType::CreditCard);
        assert_eq!(result[0].source, DetectionSource::Regex);
    }

    #[test]
    fn non_authoritative_conflicts_still_fall_back_to_score() {
        let spans = vec![
            sourced_span(0, 10, 0.70, EntityType::Person, DetectionSource::Regex),
            sourced_span(0, 10, 0.95, EntityType::Organization, DetectionSource::Ner),
        ];

        let result = merge_spans(spans);

        assert_eq!(result.len(), 1);
        assert_eq!(result[0].entity_type, EntityType::Organization);
        assert_eq!(result[0].source, DetectionSource::Ner);
    }

    #[test]
    fn checksum_validated_iban_beats_context_boosted_phone_fragment() {
        // "DE89 3704 0044 0532 0130 00, Tel 030 ..." — the phone-shaped
        // fragment inside the IBAN picked up the "Tel" boost (0.85 > 0.80).
        let spans = vec![
            span(0, 27, 0.80, EntityType::Iban),
            span(5, 19, 0.85, EntityType::Phone),
        ];

        let result = merge_spans(spans);

        assert_eq!(result.len(), 1);
        assert_eq!(result[0].entity_type, EntityType::Iban);
        assert_eq!((result[0].start, result[0].end), (0, 27));
    }

    #[test]
    fn credit_card_beats_overlapping_phone_regardless_of_order_or_score() {
        let spans = vec![
            span(0, 14, 0.95, EntityType::Phone),
            span(0, 19, 0.75, EntityType::CreditCard),
        ];

        let result = merge_spans(spans);

        assert_eq!(result.len(), 1);
        assert_eq!(result[0].entity_type, EntityType::CreditCard);
    }

    #[test]
    fn higher_precedence_span_starting_later_still_wins() {
        // A weak span that starts first must not shadow a stronger span that
        // starts inside it.
        let spans = vec![
            span(0, 12, 0.90, EntityType::Date),
            span(6, 20, 0.70, EntityType::Phone),
            span(15, 30, 0.80, EntityType::Iban),
        ];

        let result = merge_spans(spans);

        assert_eq!(result.len(), 2);
        assert_eq!(result[0].entity_type, EntityType::Date);
        assert_eq!(result[1].entity_type, EntityType::Iban);
    }

    #[test]
    fn email_beats_phone_digits_inside_it_and_ip_beats_phone() {
        let result = merge_spans(vec![
            span(0, 24, 0.95, EntityType::Email),
            span(0, 13, 0.85, EntityType::Phone),
            span(30, 41, 0.85, EntityType::IpAddress),
            span(30, 39, 0.99, EntityType::Phone),
        ]);

        assert_eq!(result.len(), 2);
        assert_eq!(result[0].entity_type, EntityType::Email);
        assert_eq!(result[1].entity_type, EntityType::IpAddress);
    }

    #[test]
    fn manual_span_beats_every_detection() {
        let result = merge_spans(vec![
            span(0, 22, 1.0, EntityType::Iban),
            sourced_span(0, 10, 0.1, EntityType::Misc, DetectionSource::Manual),
        ]);

        assert_eq!(result.len(), 1);
        assert_eq!(result[0].source, DetectionSource::Manual);
    }

    #[test]
    fn merged_spans_are_returned_in_text_order() {
        let result = merge_spans(vec![
            span(40, 50, 0.95, EntityType::Email),
            span(0, 10, 0.70, EntityType::Phone),
            span(20, 30, 0.80, EntityType::Iban),
        ]);

        let starts: Vec<_> = result.iter().map(|s| s.start).collect();
        assert_eq!(starts, vec![0, 20, 40]);
    }
}
