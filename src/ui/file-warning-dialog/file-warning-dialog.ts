/**
 * Privacy Guardrail — File upload warning (Shadow DOM)
 *
 * Shown when an uploaded Word, Excel, PowerPoint or PDF file contains
 * personal data, or could not be checked. The upload is held until the user
 * decides; every way of closing the dialog other than "Upload anyway" keeps
 * the file off the page.
 */

import type { ThemeSetting } from '../../shared/message-types';

export interface FileWarningFinding {
  label: string;
  count: number;
  examples: string[];
}

export interface FileWarningEntry {
  fileName: string;
  formatLabel: string;
  findings: FileWarningFinding[];
  /** Why the file was not (fully) checked, when it was not. */
  notice?: string;
}

const STYLES = `
  :host { all: initial; }
  .backdrop {
    position: fixed;
    inset: 0;
    z-index: 2147483647;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 20px;
    background: rgba(6, 8, 18, 0.52);
    font-family: system-ui, -apple-system, Segoe UI, sans-serif;
  }
  .dialog {
    width: min(520px, 100%);
    max-height: calc(100vh - 40px);
    display: flex;
    flex-direction: column;
    box-sizing: border-box;
    border-radius: 16px;
    padding: 20px;
    background: #18192b;
    color: #e9eaf6;
    border: 1px solid rgba(92, 96, 130, 0.72);
    box-shadow: 0 18px 50px rgba(0, 0, 0, 0.38);
  }
  .dialog[data-theme="light"] {
    background: #ffffff;
    color: #1f2933;
    border-color: #e4e6eb;
    box-shadow: 0 18px 50px rgba(15, 23, 42, 0.18);
  }
  .header { display: flex; justify-content: space-between; gap: 12px; align-items: flex-start; }
  h2 { margin: 0 0 10px; font-size: 18px; line-height: 1.2; font-weight: 650; }
  h2::before { content: '\\26A0'; color: #f59e0b; margin-right: 8px; }
  p { margin: 0 0 14px; font-size: 13px; line-height: 1.5; color: #b8bbd0; }
  .dialog[data-theme="light"] p { color: #52606d; }
  .files { overflow: auto; margin: 0 0 16px; padding: 0; list-style: none; display: grid; gap: 10px; }
  .file {
    border: 1px solid rgba(136, 140, 170, 0.35);
    border-radius: 10px;
    padding: 10px 12px;
    font-size: 13px;
    line-height: 1.45;
  }
  .file-name { font-weight: 600; word-break: break-all; }
  .file-format { opacity: 0.7; font-weight: 400; margin-left: 6px; }
  .notice { margin-top: 4px; color: #f59e0b; }
  .dialog[data-theme="light"] .notice { color: #b45309; }
  .findings { margin: 6px 0 0; padding: 0 0 0 18px; }
  .examples {
    display: block;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 12px;
    opacity: 0.8;
    word-break: break-all;
  }
  .close {
    appearance: none; border: 0; background: transparent; color: inherit; cursor: pointer;
    font-size: 20px; line-height: 1; padding: 0 2px; opacity: 0.74;
  }
  .actions { display: flex; justify-content: flex-end; gap: 10px; flex-wrap: wrap; }
  button { font: inherit; }
  .secondary, .primary { border-radius: 9px; padding: 8px 13px; cursor: pointer; font-size: 13px; }
  .primary { background: #2563eb; color: #fff; border: 1px solid #2563eb; font-weight: 600; }
  .secondary { background: transparent; color: inherit; border: 1px solid rgba(136, 140, 170, 0.55); }
  .close:focus-visible, .secondary:focus-visible, .primary:focus-visible {
    outline: 2px solid #60a5fa; outline-offset: 2px;
  }
`;

const MAX_EXAMPLE_LENGTH = 48;

function shorten(value: string): string {
  const flat = value.replace(/\s+/g, ' ').trim();
  return flat.length > MAX_EXAMPLE_LENGTH ? `${flat.slice(0, MAX_EXAMPLE_LENGTH - 1)}…` : flat;
}

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function renderEntry(entry: FileWarningEntry): HTMLLIElement {
  const item = element('li', 'file');
  const name = element('div', 'file-name', entry.fileName);
  if (entry.formatLabel) name.appendChild(element('span', 'file-format', entry.formatLabel));
  item.appendChild(name);

  if (entry.notice) item.appendChild(element('div', 'notice', entry.notice));

  if (entry.findings.length > 0) {
    const list = element('ul', 'findings');
    for (const finding of entry.findings) {
      const row = element('li', 'finding', `${finding.label}: ${finding.count}`);
      if (finding.examples.length > 0) {
        row.appendChild(element('span', 'examples', finding.examples.map(shorten).join(' · ')));
      }
      list.appendChild(row);
    }
    item.appendChild(list);
  }
  return item;
}

export class FileWarningDialog {
  private host: HTMLDivElement | null = null;
  private previousActive: Element | null = null;

  constructor(private readonly theme: ThemeSetting = 'dark') {}

  /**
   * Resolves `true` only when the user chooses to upload anyway. `copy`
   * replaces the default title and explanation.
   */
  show(entries: FileWarningEntry[], copy?: { title: string; body: string }): Promise<boolean> {
    this.dispose();
    this.previousActive = document.activeElement;
    this.host = document.createElement('div');
    this.host.id = 'pg-file-warning-dialog-host';
    const shadow = this.host.attachShadow({ mode: 'open' });

    const anyFindings = entries.some((entry) => entry.findings.length > 0);
    const title = copy?.title
      ?? (anyFindings ? 'Personal data found in upload' : 'Upload could not be fully checked');
    const body = copy?.body
      ?? (anyFindings
        ? 'Privacy Guardrail found personal data in the file you are about to upload. Files are sent as they are — nothing in them is replaced.'
        : 'Privacy Guardrail could not check all of this upload for personal data.');
    const primaryLabel = entries.length === 1 ? 'Upload anyway' : 'Upload all anyway';
    const secondaryLabel = entries.length === 1 ? 'Don’t upload' : 'Don’t upload any';

    shadow.innerHTML = `
      <style>${STYLES}</style>
      <div class="backdrop" part="backdrop">
        <section class="dialog" data-theme="${this.theme}" role="alertdialog" aria-modal="true" aria-labelledby="pg-file-title" aria-describedby="pg-file-body">
          <div class="header">
            <h2 id="pg-file-title"></h2>
            <button class="close" type="button" aria-label="Close">×</button>
          </div>
          <p id="pg-file-body"></p>
          <ul class="files"></ul>
          <div class="actions">
            <button class="secondary" type="button"></button>
            <button class="primary" type="button"></button>
          </div>
        </section>
      </div>
    `;
    (shadow.getElementById('pg-file-title') as HTMLElement).textContent = title;
    (shadow.getElementById('pg-file-body') as HTMLElement).textContent = body;
    const files = shadow.querySelector('.files') as HTMLUListElement;
    for (const entry of entries) files.appendChild(renderEntry(entry));
    document.body.appendChild(this.host);

    const backdrop = shadow.querySelector('.backdrop') as HTMLElement;
    const dialog = shadow.querySelector('.dialog') as HTMLElement;
    const primary = shadow.querySelector('.primary') as HTMLButtonElement;
    const secondary = shadow.querySelector('.secondary') as HTMLButtonElement;
    const close = shadow.querySelector('.close') as HTMLButtonElement;
    primary.textContent = primaryLabel;
    secondary.textContent = secondaryLabel;
    const focusables = [close, secondary, primary];

    return new Promise((resolve) => {
      const finish = (upload: boolean): void => {
        document.removeEventListener('keydown', onKeyDown, true);
        this.dispose();
        resolve(upload);
      };
      const onKeyDown = (event: KeyboardEvent): void => {
        if (event.key === 'Escape') {
          event.preventDefault();
          finish(false);
          return;
        }
        if (event.key === 'Tab') {
          const index = focusables.indexOf((shadow.activeElement || document.activeElement) as HTMLButtonElement);
          const next = event.shiftKey
            ? (index <= 0 ? focusables.length - 1 : index - 1)
            : (index === focusables.length - 1 ? 0 : index + 1);
          event.preventDefault();
          focusables[next].focus();
        }
      };

      primary.addEventListener('click', () => finish(true));
      secondary.addEventListener('click', () => finish(false));
      close.addEventListener('click', () => finish(false));
      backdrop.addEventListener('click', (event) => {
        if (event.target === backdrop) finish(false);
      });
      dialog.addEventListener('click', (event) => event.stopPropagation());
      document.addEventListener('keydown', onKeyDown, true);
      // The safe choice holds focus, so a reflexive Enter does not upload.
      secondary.focus();
    });
  }

  dispose(): void {
    this.host?.remove();
    this.host = null;
    if (this.previousActive instanceof HTMLElement) {
      this.previousActive.focus();
    }
  }
}
