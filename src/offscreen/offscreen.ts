import type {
  CancelDetectionRequest,
  DetectPiiRequest,
  DetectionCanceledResponse,
  GetNerStatusRequest,
  Message,
  NerStatusResponse,
  OffscreenPongResponse,
  FileScanResultResponse,
  PiiResultResponse,
  ScanFileRequest,
} from '../shared/message-types';
import { base64ToBytes } from '../shared/file-scan';
import { debugLog, initDebugFlag } from './debug';
import { detectWithExternalNer, getNerStatus } from './detection';
import { extractFileText, FileTextError } from './file-text';

initDebugFlag();

const activeDetections = new Map<string, AbortController>();
const canceledDetections = new Set<string>();

function canceledResponse(requestId: string): DetectionCanceledResponse {
  return {
    type: 'DETECTION_CANCELED',
    payload: { requestId },
  };
}

function fileScanResult(
  requestId: string,
  status: FileScanResultResponse['payload']['status'],
  rest: Partial<Omit<FileScanResultResponse['payload'], 'requestId' | 'status'>> = {},
): FileScanResultResponse {
  return {
    type: 'FILE_SCAN_RESULT',
    payload: { requestId, status, text: '', spans: [], truncated: false, ...rest },
  };
}

/** Extract an uploaded document's text, then run the same detection a paste gets. */
async function scanFile(message: ScanFileRequest, signal: AbortSignal): Promise<FileScanResultResponse> {
  const { requestId, format, dataBase64, config } = message.payload;
  const bytes = base64ToBytes(dataBase64);
  debugLog('[PG:offscreen] SCAN_FILE received', { requestId, format, bytes: bytes.length });

  let extracted;
  try {
    extracted = await extractFileText(bytes, format, signal);
  } catch (error) {
    if (error instanceof FileTextError) {
      return fileScanResult(requestId, 'unreadable', { error: error.message });
    }
    throw error;
  }

  if (!extracted.text.trim()) {
    return fileScanResult(requestId, 'no-text');
  }

  const { spans } = await detectWithExternalNer(extracted.text, config, signal);
  debugLog('[PG:offscreen] SCAN_FILE result', {
    requestId,
    textLength: extracted.text.length,
    truncated: extracted.truncated,
    spanCount: spans.length,
  });
  return fileScanResult(requestId, 'scanned', {
    text: extracted.text,
    spans,
    truncated: extracted.truncated,
  });
}

/**
 * Offscreen document — receives DETECT_PII messages from the service worker,
 * runs the WASM detection pipeline, and returns results.
 */
chrome.runtime.onMessage.addListener(
  (message: Message, sender, sendResponse) => {
    if (message.type === 'OFFSCREEN_PING') {
      const pong: OffscreenPongResponse = { type: 'OFFSCREEN_PONG' };
      sendResponse(pong);
      return false;
    }

    if (message.type === 'CANCEL_DETECTION') {
      const { requestId } = (message as CancelDetectionRequest).payload;
      const activeDetection = activeDetections.get(requestId);
      if (activeDetection) {
        activeDetection.abort();
        activeDetections.delete(requestId);
      } else {
        canceledDetections.add(requestId);
        window.setTimeout(() => canceledDetections.delete(requestId), 300000);
      }
      sendResponse(canceledResponse(requestId));
      return false;
    }

    if (message.type === 'GET_NER_STATUS') {
      const { config } = (message as GetNerStatusRequest).payload ?? {};
      const response: NerStatusResponse = {
        type: 'NER_STATUS',
        payload: getNerStatus(config),
      };
      sendResponse(response);
      return false;
    }

    if (message.type === 'SCAN_FILE') {
      // A content script's message reaches this document as well as the
      // service worker. Only the worker's forwarded copy (no tab) is scanned,
      // so a file is never extracted and analyzed twice.
      if (sender.tab) return false;
      const { requestId } = (message as ScanFileRequest).payload;
      if (canceledDetections.delete(requestId)) {
        sendResponse(canceledResponse(requestId));
        return false;
      }
      const abortController = new AbortController();
      activeDetections.set(requestId, abortController);
      scanFile(message as ScanFileRequest, abortController.signal)
        .then((response) => sendResponse(response))
        .catch((err) => {
          if (abortController.signal.aborted || err?.name === 'AbortError') {
            sendResponse(canceledResponse(requestId));
            return;
          }
          console.error('[PG:offscreen] File scan error:', err);
          sendResponse(fileScanResult(requestId, 'unreadable', {
            error: err instanceof Error ? err.message : String(err),
          }));
        })
        .finally(() => activeDetections.delete(requestId));
      return true;
    }

    if (message.type !== 'DETECT_PII') return false;

    const { text, requestId, config } = (message as DetectPiiRequest).payload;
    if (canceledDetections.delete(requestId)) {
      sendResponse(canceledResponse(requestId));
      return false;
    }

    debugLog('[PG:offscreen] DETECT_PII received', {
      requestId,
      textLength: text.length,
      config,
    });
    const startTime = performance.now();
    const abortController = new AbortController();
    activeDetections.set(requestId, abortController);

    detectWithExternalNer(text, config, abortController.signal)
      .then(({ spans, nerMs }) => {
        activeDetections.delete(requestId);
        const totalMs = Math.round(performance.now() - startTime);
        const response: PiiResultResponse = {
          type: 'PII_RESULT',
          payload: { requestId, spans, timings: { totalMs, nerMs } },
        };
        sendResponse(response);
      })
      .catch((err) => {
        activeDetections.delete(requestId);
        if (abortController.signal.aborted || err?.name === 'AbortError') {
          sendResponse(canceledResponse(requestId));
          return;
        }

        console.error('[PG:offscreen] Detection error:', err);
        sendResponse({
          type: 'PII_RESULT',
          payload: { requestId, spans: [], timings: { totalMs: 0 } },
        });
      });

    return true; // keep channel open for async response
  }
);

console.log('[PG:offscreen] Offscreen document ready');
