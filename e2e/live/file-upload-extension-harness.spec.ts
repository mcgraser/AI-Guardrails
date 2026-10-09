import { access } from 'node:fs/promises';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { strToU8, zipSync } from 'fflate';
import { ExtensionHarness } from './harness';

/**
 * Upload scanning against the built extension: a stand-in chat page served on
 * a supported origin (no network) records which files reach the page.
 */

const PAGE = `<!doctype html><html><body>
  <input type="file" id="picker" multiple>
  <div id="dropzone" style="width:300px;height:200px;border:1px solid">drop</div>
  <textarea id="composer"></textarea>
  <script>
    window.received = [];
    const record = (via, files) => window.received.push(...Array.from(files).map((f) => via + ':' + f.name));
    document.getElementById('picker').addEventListener('change', (e) => record('picker', e.target.files));
    const zone = document.getElementById('dropzone');
    zone.addEventListener('dragover', (e) => e.preventDefault());
    zone.addEventListener('drop', (e) => { e.preventDefault(); record('drop', e.dataTransfer.files); });
    document.addEventListener('paste', (e) => record('paste', e.clipboardData.files));
  </script>
</body></html>`;

function docx(paragraphs: string[]): Buffer {
  const body = paragraphs.map((p) => `<w:p><w:r><w:t>${p}</w:t></w:r></w:p>`).join('');
  return Buffer.from(zipSync({
    'word/document.xml': strToU8(`<w:document xmlns:w="w"><w:body>${body}</w:body></w:document>`),
  }));
}

/** A one-page PDF whose text layer holds `lines` (pdf.js rebuilds the omitted xref table). */
function pdf(lines: string[]): Buffer {
  const content = lines.map((line, i) => `BT /F1 12 Tf 72 ${720 - i * 20} Td (${line}) Tj ET`).join('\n');
  return Buffer.from([
    '%PDF-1.4',
    '1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj',
    '2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj',
    '3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >> endobj',
    `4 0 obj << /Length ${content.length} >> stream\n${content}\nendstream endobj`,
    '5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj',
    'trailer << /Root 1 0 R >>',
    '%%EOF',
  ].join('\n'), 'latin1');
}

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const PII_DOCX = docx(['Contact max.mustermann@example.com', 'IBAN DE89 3704 0044 0532 0130 00']);
const CLEAN_DOCX = docx(['The quarterly numbers look fine.']);

/** A freshly started extension worker can briefly be evaluated before its globals exist. */
async function configureWhenReady(harness: ExtensionHarness, settings: Parameters<ExtensionHarness['configure']>[0]): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await harness.configure(settings);
      return;
    } catch (error) {
      if (attempt >= 40) throw error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}

async function received(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as unknown as { received: string[] }).received);
}

async function dropFile(page: Page, name: string, data: Buffer): Promise<void> {
  await page.evaluate(({ name, bytes, type }) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([new Uint8Array(bytes)], name, { type }));
    document.getElementById('dropzone')!.dispatchEvent(new DragEvent('drop', {
      bubbles: true, cancelable: true, composed: true, dataTransfer: transfer,
    }));
  }, { name, bytes: [...data], type: DOCX_MIME });
}

test.describe('file upload scanning', () => {
  let harness: ExtensionHarness;
  let page: Page;

  test.beforeEach(async () => {
    const buildDir = path.resolve('dist');
    await access(path.join(buildDir, 'manifest.json'));
    harness = await ExtensionHarness.launch({
      buildDir,
      headless: true,
      viewport: { width: 1200, height: 800 },
      locale: 'en-US',
      timezoneId: 'Europe/Berlin',
      deepDiagnostics: false,
      recordTrace: false,
    });
    await configureWhenReady(harness, { nerProvider: 'off', enabled: true, fileScanEnabled: true });
    await harness.context.route('https://claude.ai/**', (route) =>
      route.fulfill({ status: 200, contentType: 'text/html', body: PAGE }));
    page = harness.page;
    await page.goto('https://claude.ai/new');
  });

  test.afterEach(async () => {
    await harness.close();
  });

  test('a clean document passes through the file picker', async () => {
    await page.setInputFiles('#picker', { name: 'clean.docx', mimeType: DOCX_MIME, buffer: CLEAN_DOCX });
    await expect.poll(() => received(page), { timeout: 20_000 }).toEqual(['picker:clean.docx']);
  });

  test('a document with personal data is held until the user decides', async () => {
    await page.setInputFiles('#picker', { name: 'letter.docx', mimeType: DOCX_MIME, buffer: PII_DOCX });

    const dialog = page.locator('#pg-file-warning-dialog-host');
    await expect(dialog.getByText('Personal data found in upload')).toBeVisible({ timeout: 20_000 });
    await expect(dialog.getByText(/Email addresses: 1/)).toBeVisible();
    await expect(dialog.getByText(/IBANs: 1/)).toBeVisible();
    expect(await received(page)).toEqual([]);

    await dialog.getByRole('button', { name: 'Upload anyway' }).click();
    await expect.poll(() => received(page)).toEqual(['picker:letter.docx']);
  });

  test('declining keeps a dropped document off the page', async () => {
    await dropFile(page, 'letter.docx', PII_DOCX);

    const dialog = page.locator('#pg-file-warning-dialog-host');
    await expect(dialog.getByText('Personal data found in upload')).toBeVisible({ timeout: 20_000 });
    await dialog.getByRole('button', { name: 'Don’t upload' }).click();

    await expect(dialog).toHaveCount(0);
    expect(await received(page)).toEqual([]);
  });

  test('accepting re-delivers a dropped document with its file', async () => {
    await dropFile(page, 'letter.docx', PII_DOCX);

    const dialog = page.locator('#pg-file-warning-dialog-host');
    await dialog.getByRole('button', { name: 'Upload anyway' }).click({ timeout: 20_000 });
    await expect.poll(() => received(page)).toEqual(['drop:letter.docx']);
  });

  test('reads the text layer of a PDF', async () => {
    await page.setInputFiles('#picker', {
      name: 'invoice.pdf',
      mimeType: 'application/pdf',
      buffer: pdf(['Invoice for anna.schmidt@example.org', 'Thank you']),
    });

    const dialog = page.locator('#pg-file-warning-dialog-host');
    await expect(dialog.getByText(/Email addresses: 1/)).toBeVisible({ timeout: 30_000 });
    await expect(dialog.getByText('anna.schmidt@example.org')).toBeVisible();
  });

  test('a PDF without a text layer is reported as unchecked, not clean', async () => {
    await page.setInputFiles('#picker', { name: 'scan.pdf', mimeType: 'application/pdf', buffer: pdf([]) });

    const dialog = page.locator('#pg-file-warning-dialog-host');
    await expect(dialog.getByText('Upload could not be fully checked')).toBeVisible({ timeout: 30_000 });
    await expect(dialog.getByText(/no OCR/)).toBeVisible();
    expect(await received(page)).toEqual([]);
  });

  test('a pasted document is held and re-delivered on consent', async () => {
    await page.focus('#composer');
    await page.evaluate(({ bytes, type }) => {
      const transfer = new DataTransfer();
      transfer.items.add(new File([new Uint8Array(bytes)], 'pasted.docx', { type }));
      document.getElementById('composer')!.dispatchEvent(new ClipboardEvent('paste', {
        bubbles: true, cancelable: true, composed: true, clipboardData: transfer,
      }));
    }, { bytes: [...PII_DOCX], type: DOCX_MIME });

    const dialog = page.locator('#pg-file-warning-dialog-host');
    await expect(dialog.getByText('Personal data found in upload')).toBeVisible({ timeout: 20_000 });
    expect(await received(page)).toEqual([]);
    await dialog.getByRole('button', { name: 'Upload anyway' }).click();
    await expect.poll(() => received(page)).toEqual(['paste:pasted.docx']);
  });

  test('uploads are not held when file scanning is off', async () => {
    await configureWhenReady(harness, { fileScanEnabled: false });
    await page.reload();
    await page.setInputFiles('#picker', { name: 'letter.docx', mimeType: DOCX_MIME, buffer: PII_DOCX });
    await expect.poll(() => received(page)).toEqual(['picker:letter.docx']);
  });
});
