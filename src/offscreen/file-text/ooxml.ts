/**
 * Text extraction for Office Open XML documents (Word .docx, Excel .xlsx,
 * PowerPoint .pptx and their macro/template variants).
 *
 * The containers are ZIP archives of XML parts. Only the parts that carry
 * user-visible text are decompressed, and the XML is read with targeted
 * regular expressions instead of a DOM: the parts can be large, the tags of
 * interest are flat, and this keeps the extractor usable outside a document
 * (tests run it under Node).
 *
 * Text that is in the file but not on screen is included on purpose — tracked
 * deletions, comments, speaker notes, hidden sheets, document properties such
 * as the author. Uploading the file uploads all of it.
 */

import { unzipSync, type UnzipFileInfo } from 'fflate';
import { MAX_OOXML_UNCOMPRESSED_BYTES } from '../../shared/file-scan';

export type OoxmlFormat = 'docx' | 'xlsx' | 'pptx';

export class FileTextError extends Error {
  constructor(
    readonly code: 'corrupt' | 'encrypted' | 'too-large',
    message: string,
  ) {
    super(message);
    this.name = 'FileTextError';
  }
}

const XML_ENTITY = /&(?:#x([0-9a-fA-F]+)|#([0-9]+)|(amp|lt|gt|quot|apos));/g;
const NAMED_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

export function decodeXmlEntities(value: string): string {
  if (!value.includes('&')) return value;
  return value.replace(XML_ENTITY, (match, hex: string | undefined, dec: string | undefined, named: string | undefined) => {
    if (named) return NAMED_ENTITIES[named];
    const codePoint = hex ? parseInt(hex, 16) : parseInt(dec as string, 10);
    try {
      return String.fromCodePoint(codePoint);
    } catch {
      return match;
    }
  });
}

/** Compound File Binary signature: an encrypted OOXML file or a legacy .doc/.xls/.ppt. */
function isCompoundFile(bytes: Uint8Array): boolean {
  return bytes.length >= 8
    && bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0
    && bytes[4] === 0xa1 && bytes[5] === 0xb1 && bytes[6] === 0x1a && bytes[7] === 0xe1;
}

function readParts(bytes: Uint8Array, wanted: (name: string) => boolean): Map<string, string> {
  if (isCompoundFile(bytes)) {
    throw new FileTextError(
      'encrypted',
      'The file is password-protected or uses a legacy binary Office format.',
    );
  }

  let budget = MAX_OOXML_UNCOMPRESSED_BYTES;
  let overBudget = false;
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(bytes, {
      filter: (file: UnzipFileInfo) => {
        if (!wanted(file.name)) return false;
        if (file.originalSize > budget) {
          overBudget = true;
          return false;
        }
        budget -= file.originalSize;
        return true;
      },
    });
  } catch (error) {
    throw new FileTextError('corrupt', `The file could not be opened (${error instanceof Error ? error.message : String(error)}).`);
  }
  if (overBudget) {
    throw new FileTextError('too-large', 'The file expands to more data than can be checked.');
  }

  const decoder = new TextDecoder('utf-8');
  const parts = new Map<string, string>();
  for (const [name, data] of Object.entries(entries)) {
    parts.set(name, decoder.decode(data));
  }
  return parts;
}

/** Parts named `prefix<N>.xml`, in numeric order (slide2 before slide10). */
function numbered(parts: Map<string, string>, prefix: string): string[] {
  const pattern = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}(\\d+)\\.xml$`);
  return [...parts.keys()]
    .map((name) => ({ name, match: pattern.exec(name) }))
    .filter((entry): entry is { name: string; match: RegExpExecArray } => entry.match !== null)
    .sort((a, b) => Number(a.match[1]) - Number(b.match[1]))
    .map((entry) => parts.get(entry.name) as string);
}

function tidy(text: string): string {
  return text
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// --- Document properties (docProps/core.xml, docProps/app.xml) ---

const CORE_PROPERTY = /<(dc:creator|cp:lastModifiedBy|dc:title|dc:subject|cp:keywords|dc:description|cp:category)(?:\s[^>]*)?>([^<]*)<\/\1>/g;
const APP_PROPERTY = /<(Company|Manager)(?:\s[^>]*)?>([^<]*)<\/\1>/g;

function documentProperties(parts: Map<string, string>): string {
  const values: string[] = [];
  for (const [name, pattern] of [['docProps/core.xml', CORE_PROPERTY], ['docProps/app.xml', APP_PROPERTY]] as const) {
    const xml = parts.get(name);
    if (!xml) continue;
    for (const match of xml.matchAll(pattern)) {
      const value = decodeXmlEntities(match[2]).trim();
      if (value) values.push(value);
    }
  }
  return values.join('\n');
}

function isPropertiesPart(name: string): boolean {
  return name === 'docProps/core.xml' || name === 'docProps/app.xml';
}

// --- Word ---

const WORD_TOKEN = /<w:(?:t|delText)(?:\s[^>]*)?>([^<]*)<\/w:(?:t|delText)>|<w:(?:tab|br|cr)\b[^>]*\/>|<\/w:p>|<\/w:tc>/g;

export function wordXmlToText(xml: string): string {
  let out = '';
  for (const match of xml.matchAll(WORD_TOKEN)) {
    const token = match[0];
    if (match[1] !== undefined) {
      out += decodeXmlEntities(match[1]);
    } else if (token === '</w:p>') {
      out += '\n';
    } else if (token === '</w:tc>' || token.startsWith('<w:tab')) {
      out += '\t';
    } else {
      out += '\n';
    }
  }
  return out;
}

const WORD_PART = /^word\/(document|header\d*|footer\d*|footnotes|endnotes|comments|glossary\/document)\.xml$/;

function extractDocx(bytes: Uint8Array): string {
  const parts = readParts(bytes, (name) => WORD_PART.test(name) || isPropertiesPart(name));
  const body = parts.get('word/document.xml');
  if (body === undefined) {
    throw new FileTextError('corrupt', 'The file is not a Word document.');
  }
  const sections = [
    wordXmlToText(body),
    ...numbered(parts, 'word/header').map(wordXmlToText),
    ...numbered(parts, 'word/footer').map(wordXmlToText),
    ...['word/footnotes.xml', 'word/endnotes.xml', 'word/comments.xml']
      .map((name) => parts.get(name))
      .filter((xml): xml is string => xml !== undefined)
      .map(wordXmlToText),
    documentProperties(parts),
  ];
  return tidy(sections.filter((section) => section.trim()).join('\n\n'));
}

// --- PowerPoint ---

const DRAWING_TOKEN = /<a:t(?:\s[^>]*)?>([^<]*)<\/a:t>|<a:br\b[^>]*\/>|<\/a:p>|<\/a:tc>/g;

export function drawingXmlToText(xml: string): string {
  let out = '';
  for (const match of xml.matchAll(DRAWING_TOKEN)) {
    if (match[1] !== undefined) {
      out += decodeXmlEntities(match[1]);
    } else if (match[0] === '</a:tc>') {
      out += '\t';
    } else {
      out += '\n';
    }
  }
  return out;
}

const COMMENT_TEXT = /<p:text(?:\s[^>]*)?>([^<]*)<\/p:text>/g;

function commentXmlToText(xml: string): string {
  return [...xml.matchAll(COMMENT_TEXT)].map((match) => decodeXmlEntities(match[1])).join('\n')
    // Modern threaded comments keep their text in DrawingML paragraphs.
    + drawingXmlToText(xml);
}

const PRESENTATION_PART = /^ppt\/(slides\/slide\d+|notesSlides\/notesSlide\d+|comments\/[^/]+|charts\/chart\d+)\.xml$/;

function extractPptx(bytes: Uint8Array): string {
  const parts = readParts(bytes, (name) => PRESENTATION_PART.test(name) || isPropertiesPart(name));
  const slides = numbered(parts, 'ppt/slides/slide');
  if (slides.length === 0 && !parts.has('docProps/core.xml')) {
    throw new FileTextError('corrupt', 'The file is not a PowerPoint presentation.');
  }
  const comments = [...parts.entries()]
    .filter(([name]) => name.startsWith('ppt/comments/'))
    .map(([, xml]) => commentXmlToText(xml));
  const sections = [
    ...slides.map(drawingXmlToText),
    ...numbered(parts, 'ppt/notesSlides/notesSlide').map(drawingXmlToText),
    ...numbered(parts, 'ppt/charts/chart').map(drawingXmlToText),
    ...comments,
    documentProperties(parts),
  ];
  return tidy(sections.filter((section) => section.trim()).join('\n\n'));
}

// --- Excel ---

const SHARED_STRING_ITEM = /<si(?:\s[^>]*)?>([\s\S]*?)<\/si>|<si\s*\/>/g;
const TEXT_RUN = /<t(?:\s[^>]*)?>([^<]*)<\/t>/g;
// Phonetic guides (<rPh>) repeat the reading of East Asian text; skip them.
const PHONETIC_RUN = /<rPh\b[\s\S]*?<\/rPh>/g;

function runsText(xml: string): string {
  let out = '';
  for (const match of xml.replace(PHONETIC_RUN, '').matchAll(TEXT_RUN)) {
    out += decodeXmlEntities(match[1]);
  }
  return out;
}

export function parseSharedStrings(xml: string): string[] {
  return [...xml.matchAll(SHARED_STRING_ITEM)].map((match) => (match[1] === undefined ? '' : runsText(match[1])));
}

const SHEET_ROW = /<row\b[^>]*>([\s\S]*?)<\/row>/g;
const SHEET_CELL = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
const CELL_TYPE = /\bt="([^"]*)"/;
const CELL_VALUE = /<v(?:\s[^>]*)?>([^<]*)<\/v>/;
const INLINE_STRING = /<is(?:\s[^>]*)?>([\s\S]*?)<\/is>/;

export function sheetXmlToText(xml: string, sharedStrings: string[]): string {
  const lines: string[] = [];
  for (const row of xml.matchAll(SHEET_ROW)) {
    const cells: string[] = [];
    for (const cell of row[1].matchAll(SHEET_CELL)) {
      const body = cell[2];
      if (!body) continue;
      const type = CELL_TYPE.exec(cell[1])?.[1] ?? 'n';
      let value = '';
      if (type === 'inlineStr') {
        const inline = INLINE_STRING.exec(body);
        value = inline ? runsText(inline[1]) : '';
      } else {
        const raw = CELL_VALUE.exec(body)?.[1];
        if (raw === undefined) continue;
        value = type === 's' ? sharedStrings[Number(raw)] ?? '' : decodeXmlEntities(raw);
      }
      if (value.trim()) cells.push(value);
    }
    if (cells.length > 0) lines.push(cells.join('\t'));
  }
  return lines.join('\n');
}

const WORKBOOK_PART = /^xl\/(sharedStrings|worksheets\/sheet\d+|comments\d*|threadedComments\/[^/]+|charts\/chart\d+)\.xml$/;

function extractXlsx(bytes: Uint8Array): string {
  const parts = readParts(bytes, (name) => WORKBOOK_PART.test(name) || isPropertiesPart(name));
  const sheets = numbered(parts, 'xl/worksheets/sheet');
  if (sheets.length === 0 && !parts.has('xl/sharedStrings.xml')) {
    throw new FileTextError('corrupt', 'The file is not an Excel workbook.');
  }
  const sharedStringsXml = parts.get('xl/sharedStrings.xml');
  const sharedStrings = sharedStringsXml ? parseSharedStrings(sharedStringsXml) : [];
  const comments = [...parts.entries()]
    .filter(([name]) => /^xl\/comments\d*\.xml$/.test(name) || name.startsWith('xl/threadedComments/'))
    .map(([, xml]) => runsText(xml) || [...xml.matchAll(/<text(?:\s[^>]*)?>([^<]*)<\/text>/g)].map((m) => decodeXmlEntities(m[1])).join('\n'));
  const sections = [
    ...sheets.map((xml) => sheetXmlToText(xml, sharedStrings)),
    ...numbered(parts, 'xl/charts/chart').map(drawingXmlToText),
    ...comments,
    documentProperties(parts),
  ];
  return tidy(sections.filter((section) => section.trim()).join('\n\n'));
}

export function extractOoxmlText(bytes: Uint8Array, format: OoxmlFormat): string {
  switch (format) {
    case 'docx': return extractDocx(bytes);
    case 'xlsx': return extractXlsx(bytes);
    case 'pptx': return extractPptx(bytes);
  }
}
