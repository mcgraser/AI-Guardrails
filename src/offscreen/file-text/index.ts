import { MAX_FILE_SCAN_CHARS, type ScannableFileFormat } from '../../shared/file-scan';
import { extractOoxmlText } from './ooxml';
import { extractPdfText } from './pdf';

export { FileTextError } from './ooxml';

export interface ExtractedFileText {
  text: string;
  /** Only part of the file's text was extracted (page or character cap). */
  truncated: boolean;
}

export async function extractFileText(
  bytes: Uint8Array,
  format: ScannableFileFormat,
  signal?: AbortSignal,
): Promise<ExtractedFileText> {
  const extracted = format === 'pdf'
    ? await extractPdfText(bytes, signal)
    : { text: extractOoxmlText(bytes, format), truncated: false };

  if (extracted.text.length > MAX_FILE_SCAN_CHARS) {
    return { text: extracted.text.slice(0, MAX_FILE_SCAN_CHARS), truncated: true };
  }
  return { text: extracted.text, truncated: extracted.truncated };
}
