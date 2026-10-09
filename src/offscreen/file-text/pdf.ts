/**
 * Text extraction for PDF files via pdf.js.
 *
 * Only the embedded text layer is read — there is no OCR. A scanned PDF with
 * no text layer yields no text, and the caller reports that the file could
 * not be checked rather than that it is clean.
 *
 * pdf.js is not bundled into the offscreen script: it is copied to
 * `vendor/pdfjs/` and imported on first use, so documents that never scan a
 * PDF never load it. Its worker and CMaps are loaded from the same packaged
 * directory; nothing leaves the extension.
 */

import type * as PdfJs from 'pdfjs-dist';
import { MAX_FILE_SCAN_CHARS, MAX_PDF_PAGES } from '../../shared/file-scan';
import { FileTextError } from './ooxml';

type PdfJsModule = typeof PdfJs;

export const PDFJS_VENDOR_DIR = 'vendor/pdfjs';

let pdfJsModule: Promise<PdfJsModule> | null = null;

function loadPackagedPdfJs(): Promise<PdfJsModule> {
  if (!pdfJsModule) {
    const moduleUrl = chrome.runtime.getURL(`${PDFJS_VENDOR_DIR}/pdf.min.mjs`);
    pdfJsModule = (import(/* webpackIgnore: true */ moduleUrl) as Promise<PdfJsModule>).then((pdfjs) => {
      pdfjs.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL(`${PDFJS_VENDOR_DIR}/pdf.worker.min.mjs`);
      return pdfjs;
    });
    pdfJsModule.catch(() => {
      pdfJsModule = null;
    });
  }
  return pdfJsModule;
}

export interface PdfTextResult {
  text: string;
  /** Stopped early at the page or character cap. */
  truncated: boolean;
  pageCount: number;
}

const METADATA_FIELDS = ['Author', 'Title', 'Subject', 'Keywords'] as const;

function metadataText(info: unknown): string {
  if (!info || typeof info !== 'object') return '';
  const record = info as Record<string, unknown>;
  return METADATA_FIELDS
    .map((field) => record[field])
    .filter((value): value is string => typeof value === 'string' && value.trim() !== '')
    .join('\n');
}

/** Filled-in form fields and comment annotations: not part of the text layer, still in the file. */
function annotationText(annotations: unknown[]): string {
  const values: string[] = [];
  for (const annotation of annotations as Array<Record<string, unknown>>) {
    const fieldValue = annotation.fieldValue;
    if (typeof fieldValue === 'string' && fieldValue.trim()) values.push(fieldValue);
    else if (Array.isArray(fieldValue)) values.push(...fieldValue.filter((v): v is string => typeof v === 'string'));
    const contents = (annotation.contentsObj as { str?: unknown } | undefined)?.str;
    if (typeof contents === 'string' && contents.trim()) values.push(contents);
  }
  return values.join('\n');
}

export async function extractPdfText(
  bytes: Uint8Array,
  signal?: AbortSignal,
  loadPdfJs: () => Promise<PdfJsModule> = loadPackagedPdfJs,
): Promise<PdfTextResult> {
  const pdfjs = await loadPdfJs();
  const task = pdfjs.getDocument({
    data: bytes,
    isEvalSupported: false,
    disableFontFace: true,
    useSystemFonts: false,
    stopAtErrors: false,
    cMapUrl: chrome.runtime.getURL(`${PDFJS_VENDOR_DIR}/cmaps/`),
    cMapPacked: true,
  });
  const onAbort = (): void => {
    void task.destroy();
  };
  signal?.addEventListener('abort', onAbort, { once: true });

  let document: PdfJs.PDFDocumentProxy;
  try {
    document = await task.promise;
  } catch (error) {
    signal?.removeEventListener('abort', onAbort);
    const name = (error as { name?: string } | null)?.name;
    if (name === 'PasswordException') {
      throw new FileTextError('encrypted', 'The PDF is password-protected.');
    }
    throw new FileTextError('corrupt', `The PDF could not be opened (${error instanceof Error ? error.message : String(error)}).`);
  }

  try {
    const pageCount = document.numPages;
    const pagesToRead = Math.min(pageCount, MAX_PDF_PAGES);
    const sections: string[] = [];
    let length = 0;
    let truncated = pageCount > pagesToRead;

    for (let pageNumber = 1; pageNumber <= pagesToRead; pageNumber += 1) {
      if (signal?.aborted) throw new DOMException('PDF extraction aborted', 'AbortError');
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      let pageText = '';
      for (const item of content.items) {
        if (!('str' in item)) continue;
        pageText += item.str;
        pageText += item.hasEOL ? '\n' : (item.str && !item.str.endsWith(' ') ? ' ' : '');
      }
      const annotations = annotationText(await page.getAnnotations());
      if (annotations) pageText += `\n${annotations}`;
      page.cleanup();

      sections.push(pageText.trim());
      length += pageText.length;
      if (length >= MAX_FILE_SCAN_CHARS) {
        truncated = truncated || pageNumber < pageCount;
        break;
      }
    }

    try {
      const { info } = await document.getMetadata();
      const metadata = metadataText(info);
      if (metadata) sections.push(metadata);
    } catch {
      // Metadata is a bonus; a broken info dictionary does not fail the scan.
    }

    return {
      text: sections.filter(Boolean).join('\n\n'),
      truncated,
      pageCount,
    };
  } finally {
    signal?.removeEventListener('abort', onAbort);
    void document.destroy();
  }
}
