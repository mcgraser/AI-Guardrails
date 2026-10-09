import { formatLabel } from '../shared/file-scan';
import type { EntityType, Settings } from '../shared/message-types';
import type { FileWarningEntry, FileWarningFinding } from '../ui/file-warning-dialog/file-warning-dialog';
import type { FileScanOutcome } from './file-upload-interceptor';
import { prepareReviewSpans } from './review-spans';

const ENTITY_LABELS: Record<EntityType, string> = {
  PERSON: 'Names',
  EMAIL: 'Email addresses',
  PHONE: 'Phone numbers',
  CREDIT_CARD: 'Credit card numbers',
  SSN: 'Social security numbers',
  IBAN: 'IBANs',
  IP_ADDRESS: 'IP addresses',
  LOCATION: 'Locations',
  ORGANIZATION: 'Organizations',
  ADDRESS: 'Addresses',
  URL: 'URLs',
  USERNAME: 'Usernames',
  PASSWORD: 'Passwords / secrets',
  BANK_ACCOUNT: 'Bank account numbers',
  DATE: 'Dates',
  MISC: 'Other personal data',
};

const MAX_EXAMPLES = 3;

function noticeFor(outcome: FileScanOutcome): string | undefined {
  switch (outcome.status) {
    case 'too-large':
      return 'Not checked: the file is too large to scan.';
    case 'no-text':
      return 'Not checked: the file contains no readable text. Scanned documents and images are not read (no OCR).';
    case 'unreadable':
      return `Not checked: ${outcome.error ?? 'the file could not be read.'}`;
    case 'scanned':
      return outcome.truncated ? 'Only the first part of this file was checked.' : undefined;
  }
}

function findingsFor(outcome: FileScanOutcome, settings: Settings, adaptiveThresholds: Record<string, number>): FileWarningFinding[] {
  if (outcome.status !== 'scanned' || outcome.spans.length === 0) return [];
  const spans = prepareReviewSpans(outcome.text, outcome.spans, settings, adaptiveThresholds)
    .filter((span) => !span.inCodeBlock);

  const byType = new Map<EntityType, { count: number; examples: Set<string> }>();
  for (const span of spans) {
    const bucket = byType.get(span.entity_type) ?? { count: 0, examples: new Set<string>() };
    bucket.count += 1;
    if (bucket.examples.size < MAX_EXAMPLES && span.text.trim()) bucket.examples.add(span.text.trim());
    byType.set(span.entity_type, bucket);
  }

  return [...byType.entries()]
    .sort((a, b) => b[1].count - a[1].count)
    .map(([type, bucket]) => ({
      label: ENTITY_LABELS[type] ?? type,
      count: bucket.count,
      examples: [...bucket.examples],
    }));
}

/**
 * The files of an upload that need the user's attention: those with personal
 * data after the user's filters (categories, allowlist, sensitivity), and
 * those that could not be fully checked. An empty result means the upload is
 * clean as far as the scan can tell.
 */
export function buildFileWarningEntries(
  outcomes: FileScanOutcome[],
  settings: Settings,
  adaptiveThresholds: Record<string, number>,
): FileWarningEntry[] {
  const entries: FileWarningEntry[] = [];
  for (const outcome of outcomes) {
    const findings = findingsFor(outcome, settings, adaptiveThresholds);
    const notice = noticeFor(outcome);
    if (findings.length === 0 && !notice) continue;
    // A partial scan that found nothing is not held up: every long
    // spreadsheet would prompt otherwise.
    if (findings.length === 0 && outcome.status === 'scanned') continue;
    entries.push({
      fileName: outcome.file.name,
      formatLabel: formatLabel(outcome.format),
      findings,
      notice,
    });
  }
  return entries;
}
