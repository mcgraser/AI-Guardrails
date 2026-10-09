/**
 * File-scan formats and limits shared by the content script (which decides
 * whether an upload is held for review) and the offscreen document (which
 * extracts the text and runs detection on it).
 */

export type ScannableFileFormat = 'pdf' | 'docx' | 'xlsx' | 'pptx';

/** Files larger than this are not read; the user is told they went unchecked. */
export const MAX_FILE_SCAN_BYTES = 25 * 1024 * 1024;

/**
 * Upper bound on the extracted text handed to detection. Spreadsheets and long
 * reports can hold far more text than a paste; past this point the scan is
 * partial and the warning says so.
 */
export const MAX_FILE_SCAN_CHARS = 150_000;

/** Total uncompressed bytes read out of one Office ZIP container (zip-bomb guard). */
export const MAX_OOXML_UNCOMPRESSED_BYTES = 200 * 1024 * 1024;

/** PDFs longer than this are scanned up to this page and reported as partial. */
export const MAX_PDF_PAGES = 1000;

const EXTENSION_FORMATS: Record<string, ScannableFileFormat> = {
  pdf: 'pdf',
  docx: 'docx',
  docm: 'docx',
  dotx: 'docx',
  dotm: 'docx',
  xlsx: 'xlsx',
  xlsm: 'xlsx',
  xltx: 'xlsx',
  xltm: 'xlsx',
  pptx: 'pptx',
  pptm: 'pptx',
  potx: 'pptx',
  potm: 'pptx',
  ppsx: 'pptx',
  ppsm: 'pptx',
};

const MIME_FORMATS: Record<string, ScannableFileFormat> = {
  'application/pdf': 'pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.ms-word.document.macroenabled.12': 'docx',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.template': 'docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.ms-excel.sheet.macroenabled.12': 'xlsx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.template': 'xlsx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'application/vnd.ms-powerpoint.presentation.macroenabled.12': 'pptx',
  'application/vnd.openxmlformats-officedocument.presentationml.slideshow': 'pptx',
  'application/vnd.openxmlformats-officedocument.presentationml.template': 'pptx',
};

/**
 * The format a file is scanned as, or `null` when it is not one this
 * extension reads. The extension wins over the MIME type: browsers derive the
 * type from the extension anyway, and an empty or generic type
 * (`application/octet-stream`) is common for files dropped from some apps.
 */
export function scannableFormatOf(name: string, mimeType: string): ScannableFileFormat | null {
  const dot = name.lastIndexOf('.');
  if (dot !== -1) {
    const format = EXTENSION_FORMATS[name.slice(dot + 1).toLowerCase()];
    if (format) return format;
  }
  return MIME_FORMATS[mimeType.toLowerCase()] ?? null;
}

export function formatLabel(format: ScannableFileFormat): string {
  switch (format) {
    case 'pdf': return 'PDF';
    case 'docx': return 'Word';
    case 'xlsx': return 'Excel';
    case 'pptx': return 'PowerPoint';
  }
}

const BASE64_CHUNK = 0x8000;

/** Base64 for runtime messaging, which only carries JSON-serializable values. */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += BASE64_CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + BASE64_CHUNK));
  }
  return btoa(binary);
}

export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
