import { base64ToBytes, bytesToBase64, scannableFormatOf } from '../../src/shared/file-scan';

describe('scannableFormatOf', () => {
  it.each([
    ['report.pdf', '', 'pdf'],
    ['Letter.DOCX', '', 'docx'],
    ['macro.docm', '', 'docx'],
    ['budget.xlsx', '', 'xlsx'],
    ['budget.xlsm', '', 'xlsx'],
    ['deck.pptx', '', 'pptx'],
    ['show.ppsx', '', 'pptx'],
    ['download', 'application/pdf', 'pdf'],
    ['download', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'xlsx'],
  ])('%s (%s) → %s', (name, type, expected) => {
    expect(scannableFormatOf(name, type)).toBe(expected);
  });

  it.each([
    ['photo.png', 'image/png'],
    ['notes.txt', 'text/plain'],
    ['legacy.doc', 'application/msword'],
    ['archive.zip', 'application/zip'],
  ])('ignores %s', (name, type) => {
    expect(scannableFormatOf(name, type)).toBeNull();
  });
});

describe('base64 helpers', () => {
  it('round-trips binary data larger than one chunk', () => {
    const bytes = new Uint8Array(100_000);
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = (i * 31) & 0xff;
    expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
  });
});
