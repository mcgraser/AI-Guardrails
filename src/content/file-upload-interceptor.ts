/**
 * Holds Word, Excel, PowerPoint and PDF uploads on a monitored chat page until
 * their text has been checked for personal data.
 *
 * Chat sites take files three ways: a file picker (`<input type="file">`),
 * drag and drop, and pasting a copied file. All three are caught in the
 * capture phase on `window`, ahead of the page's own listeners. When a held
 * upload is let through, the event is re-dispatched to its original target
 * with the same files, so the page receives it exactly as it would have.
 * When it is not, the files never reach the page.
 *
 * Only events that carry at least one scannable document are held. Images,
 * text pastes and every other upload pass straight through.
 */

import type {
  CancelDetectionRequest,
  DetectionCanceledResponse,
  FileScanResultResponse,
  FileScanStatus,
  PiiSpan,
} from '../shared/message-types';
import {
  MAX_FILE_SCAN_BYTES,
  bytesToBase64,
  scannableFormatOf,
  type ScannableFileFormat,
} from '../shared/file-scan';
import { sendRuntimeMessageBestEffort } from './runtime-messaging';

export interface FileScanOutcome {
  file: File;
  format: ScannableFileFormat;
  /** `too-large` files were not read at all. */
  status: FileScanStatus | 'too-large';
  text: string;
  spans: PiiSpan[];
  truncated: boolean;
  error?: string;
}

export interface FileUploadInterceptorCallbacks {
  /** Scanning has started; `cancel` aborts it. */
  onScanning: (fileCount: number, cancel: () => void) => void;
  onScanFinished: () => void;
  /**
   * Decide whether the scanned upload may proceed. Resolve `true` to hand
   * the files to the page, `false` to drop them.
   */
  review: (outcomes: FileScanOutcome[]) => Promise<boolean>;
  /** The user canceled a running scan: resolve `true` to upload unchecked. */
  onCanceled: (files: File[]) => Promise<boolean>;
  onError: (message: string) => void;
}

export interface FileUploadInterceptorOptions {
  /** Delays the decision until the content script has loaded its settings. */
  waitForReady?: () => Promise<void>;
  /** Whether uploads are checked at all; read after `waitForReady`. */
  isEnabled: () => boolean;
}

type HeldUpload =
  | { kind: 'input'; input: HTMLInputElement; files: File[]; events: Set<'input' | 'change'> }
  | { kind: 'drop'; target: EventTarget; init: DragEventInit }
  | { kind: 'paste'; target: EventTarget };

class ScanCanceledError extends Error {
  constructor() {
    super('File scan canceled');
    this.name = 'ScanCanceledError';
  }
}

function isFileInput(target: EventTarget | null): target is HTMLInputElement {
  const element = target as HTMLInputElement | null;
  return !!element && element.tagName === 'INPUT' && element.type === 'file';
}

function hasScannableFile(files: Iterable<File>): boolean {
  for (const file of files) {
    if (scannableFormatOf(file.name, file.type)) return true;
  }
  return false;
}

function composedTarget(event: Event): EventTarget | null {
  const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
  return path[0] ?? event.target;
}

function sameFiles(a: File[], b: File[]): boolean {
  return a.length === b.length && a.every((file, i) => file === b[i]);
}

function dataTransferWith(files: File[]): DataTransfer {
  const transfer = new DataTransfer();
  for (const file of files) transfer.items.add(file);
  return transfer;
}

export class FileUploadInterceptor {
  /** Events this interceptor dispatched itself, which must pass untouched. */
  private readonly released = new WeakSet<Event>();
  /** File inputs whose current selection is being scanned. */
  private readonly heldInputs = new Map<HTMLInputElement, Extract<HeldUpload, { kind: 'input' }>>();
  private requestCounter = 0;
  private readonly waitForReady: () => Promise<void>;
  private readonly isEnabled: () => boolean;

  constructor(
    private readonly callbacks: FileUploadInterceptorCallbacks,
    options: FileUploadInterceptorOptions,
  ) {
    this.waitForReady = options.waitForReady ?? (() => Promise.resolve());
    this.isEnabled = options.isEnabled;
  }

  /**
   * Register before any other capture-phase `paste` listener on `window`:
   * a pasted file must be held before a text-paste handler sees the event.
   */
  start(): void {
    window.addEventListener('input', this.handleInputChange, true);
    window.addEventListener('change', this.handleInputChange, true);
    window.addEventListener('drop', this.handleDrop, true);
    window.addEventListener('paste', this.handlePaste, true);
  }

  stop(): void {
    window.removeEventListener('input', this.handleInputChange, true);
    window.removeEventListener('change', this.handleInputChange, true);
    window.removeEventListener('drop', this.handleDrop, true);
    window.removeEventListener('paste', this.handlePaste, true);
  }

  private hold(event: Event): void {
    event.preventDefault();
    event.stopImmediatePropagation();
  }

  private handleInputChange = (event: Event): void => {
    if (this.released.has(event)) return;
    const input = composedTarget(event);
    if (!isFileInput(input)) return;

    const files = Array.from(input.files ?? []);

    // Browsers fire `input` then `change` for one selection; both belong to
    // the same hold. A different selection made while a scan is running
    // supersedes it and is checked on its own.
    const pending = this.heldInputs.get(input);
    if (pending && sameFiles(pending.files, files)) {
      this.hold(event);
      pending.events.add(event.type as 'input' | 'change');
      return;
    }

    if (!hasScannableFile(files)) {
      if (pending) this.heldInputs.delete(input);
      return;
    }

    this.hold(event);
    const held: Extract<HeldUpload, { kind: 'input' }> = {
      kind: 'input',
      input,
      files,
      events: new Set([event.type as 'input' | 'change']),
    };
    this.heldInputs.set(input, held);
    void this.process(files, held).finally(() => {
      if (this.heldInputs.get(input) === held) this.heldInputs.delete(input);
    });
  };

  private handleDrop = (event: DragEvent): void => {
    if (this.released.has(event)) return;
    const files = Array.from(event.dataTransfer?.files ?? []);
    if (!hasScannableFile(files)) return;

    this.hold(event);
    const target = composedTarget(event) ?? window;
    void this.process(files, {
      kind: 'drop',
      target,
      init: {
        bubbles: true,
        cancelable: true,
        composed: true,
        clientX: event.clientX,
        clientY: event.clientY,
        screenX: event.screenX,
        screenY: event.screenY,
      },
    });
  };

  private handlePaste = (event: ClipboardEvent): void => {
    if (this.released.has(event)) return;
    const files = Array.from(event.clipboardData?.files ?? []);
    if (!hasScannableFile(files)) return;

    this.hold(event);
    void this.process(files, { kind: 'paste', target: composedTarget(event) ?? window });
  };

  private async process(files: File[], held: HeldUpload): Promise<void> {
    let allow: boolean;
    try {
      await this.waitForReady();
      allow = this.isEnabled() ? await this.scanAndReview(files) : true;
    } catch (error) {
      // Fail closed: an upload that could not be checked is not sent on.
      // The user can still pick the file again after reading the error.
      console.error('[PG:content] File scan failed:', error);
      this.callbacks.onError(error instanceof Error ? error.message : String(error));
      allow = false;
    }

    if (allow) this.release(files, held);
    else this.discard(held);
  }

  private async scanAndReview(files: File[]): Promise<boolean> {
    const scannable = files.filter((file) => scannableFormatOf(file.name, file.type));
    const requestIds: string[] = [];
    let canceled = false;

    this.callbacks.onScanning(scannable.length, () => {
      canceled = true;
      for (const requestId of requestIds) {
        const request: CancelDetectionRequest = { type: 'CANCEL_DETECTION', payload: { requestId } };
        sendRuntimeMessageBestEffort(request);
      }
    });

    const outcomes: FileScanOutcome[] = [];
    try {
      for (const file of scannable) {
        if (canceled) throw new ScanCanceledError();
        const requestId = `pg_file_${++this.requestCounter}_${Date.now()}`;
        requestIds.push(requestId);
        try {
          outcomes.push(await this.scanFile(file, requestId));
        } catch (error) {
          if (error instanceof ScanCanceledError || canceled) throw new ScanCanceledError();
          // A file the pipeline could not check is still the user's call,
          // made in the review dialog with the reason shown.
          outcomes.push({
            file,
            format: scannableFormatOf(file.name, file.type) as ScannableFileFormat,
            status: 'unreadable',
            text: '',
            spans: [],
            truncated: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        if (canceled) throw new ScanCanceledError();
      }
    } catch (error) {
      this.callbacks.onScanFinished();
      if (error instanceof ScanCanceledError) return this.callbacks.onCanceled(files);
      throw error;
    }
    this.callbacks.onScanFinished();

    return this.callbacks.review(outcomes);
  }

  private async scanFile(file: File, requestId: string): Promise<FileScanOutcome> {
    const format = scannableFormatOf(file.name, file.type) as ScannableFileFormat;
    const base = { file, format, text: '', spans: [], truncated: false };
    if (file.size > MAX_FILE_SCAN_BYTES) {
      return { ...base, status: 'too-large' };
    }

    const bytes = new Uint8Array(await file.arrayBuffer());
    const response: FileScanResultResponse | DetectionCanceledResponse | undefined =
      await chrome.runtime.sendMessage({
        type: 'SCAN_FILE',
        payload: { requestId, fileName: file.name, format, dataBase64: bytesToBase64(bytes) },
      });

    if (response?.type === 'DETECTION_CANCELED') throw new ScanCanceledError();
    if (!response || response.type !== 'FILE_SCAN_RESULT') {
      throw new Error('Invalid response from file scan');
    }
    const { status, text, spans, truncated, error } = response.payload;
    return { ...base, status, text, spans, truncated, error };
  }

  private release(files: File[], held: HeldUpload): void {
    let event: Event;
    switch (held.kind) {
      case 'input':
        // The input now holds a newer selection; that one has its own hold.
        if (!sameFiles(Array.from(held.input.files ?? []), held.files)) return;
        for (const type of (['input', 'change'] as const).filter((t) => held.events.has(t))) {
          const replay = new Event(type, { bubbles: true, cancelable: type === 'input', composed: type === 'input' });
          this.released.add(replay);
          held.input.dispatchEvent(replay);
        }
        return;
      case 'drop':
        event = new DragEvent('drop', { ...held.init, dataTransfer: dataTransferWith(files) });
        break;
      case 'paste':
        event = new ClipboardEvent('paste', {
          bubbles: true,
          cancelable: true,
          composed: true,
          clipboardData: dataTransferWith(files),
        });
        break;
    }
    this.released.add(event);
    held.target.dispatchEvent(event);
  }

  private discard(held: HeldUpload): void {
    if (held.kind === 'input') {
      if (!sameFiles(Array.from(held.input.files ?? []), held.files)) return;
      // Clearing the selection fires no events, so the page never learns of
      // the file; picking it again starts a fresh check.
      held.input.value = '';
      return;
    }
    if (held.kind === 'drop') {
      // Drop zones track dragenter/dragleave to show their overlay. With the
      // drop withheld, close it the way a drag that left would.
      const leave = new DragEvent('dragleave', { ...held.init, dataTransfer: new DataTransfer() });
      this.released.add(leave);
      held.target.dispatchEvent(leave);
    }
  }
}
