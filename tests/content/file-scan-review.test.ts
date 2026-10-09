import { buildFileWarningEntries } from '../../src/content/file-scan-review';
import type { FileScanOutcome } from '../../src/content/file-upload-interceptor';
import { DEFAULT_SETTINGS } from '../../src/shared/constants';
import type { PiiSpan } from '../../src/shared/message-types';

const file = (name: string) => ({ name } as File);

function span(text: string, start: number, entity_type: PiiSpan['entity_type'], score = 0.99): PiiSpan {
  return { start, end: start + text.length, entity_type, score, text, source: 'regex' };
}

function scanned(name: string, text: string, spans: PiiSpan[], truncated = false): FileScanOutcome {
  return { file: file(name), format: 'docx', status: 'scanned', text, spans, truncated };
}

describe('buildFileWarningEntries', () => {
  it('returns nothing for clean files', () => {
    expect(buildFileWarningEntries([scanned('a.docx', 'hello', [])], DEFAULT_SETTINGS, {})).toEqual([]);
  });

  it('groups findings by category with counts and a few examples', () => {
    const text = 'a@example.com b@example.com c@example.com d@example.com DE89370400440532013000';
    const spans = [
      span('a@example.com', 0, 'EMAIL'),
      span('b@example.com', 14, 'EMAIL'),
      span('c@example.com', 28, 'EMAIL'),
      span('d@example.com', 42, 'EMAIL'),
      span('DE89370400440532013000', 56, 'IBAN'),
    ];
    const [entry] = buildFileWarningEntries([scanned('a.docx', text, spans)], DEFAULT_SETTINGS, {});
    expect(entry.fileName).toBe('a.docx');
    expect(entry.formatLabel).toBe('Word');
    expect(entry.findings).toEqual([
      { label: 'Email addresses', count: 4, examples: ['a@example.com', 'b@example.com', 'c@example.com'] },
      { label: 'IBANs', count: 1, examples: ['DE89370400440532013000'] },
    ]);
  });

  it('applies the user allowlist like a paste review does', () => {
    const settings = {
      ...DEFAULT_SETTINGS,
      allowlist: [{ pattern: 'team@example.com', scope: 'any' as const, addedAt: 0, source: 'manual' as const }],
    };
    const outcome = scanned('a.docx', 'team@example.com', [span('team@example.com', 0, 'EMAIL')]);
    expect(buildFileWarningEntries([outcome], settings, {})).toEqual([]);
  });

  it('warns about files that could not be checked', () => {
    const entries = buildFileWarningEntries([
      { file: file('scan.pdf'), format: 'pdf', status: 'no-text', text: '', spans: [], truncated: false },
      { file: file('big.xlsx'), format: 'xlsx', status: 'too-large', text: '', spans: [], truncated: false },
      { file: file('locked.docx'), format: 'docx', status: 'unreadable', text: '', spans: [], truncated: false, error: 'The file is password-protected.' },
    ], DEFAULT_SETTINGS, {});
    expect(entries.map((entry) => [entry.fileName, entry.notice])).toEqual([
      ['scan.pdf', expect.stringContaining('no OCR')],
      ['big.xlsx', expect.stringContaining('too large')],
      ['locked.docx', 'Not checked: The file is password-protected.'],
    ]);
  });

  it('does not hold a partially scanned file that showed nothing', () => {
    expect(buildFileWarningEntries([scanned('long.docx', 'text', [], true)], DEFAULT_SETTINGS, {})).toEqual([]);
  });

  it('notes a partial scan next to its findings', () => {
    const [entry] = buildFileWarningEntries(
      [scanned('long.docx', 'a@example.com', [span('a@example.com', 0, 'EMAIL')], true)],
      DEFAULT_SETTINGS,
      {},
    );
    expect(entry.notice).toBe('Only the first part of this file was checked.');
  });
});
