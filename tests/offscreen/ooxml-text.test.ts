import { strToU8, zipSync } from 'fflate';
import {
  FileTextError,
  decodeXmlEntities,
  extractOoxmlText,
  parseSharedStrings,
  sheetXmlToText,
} from '../../src/offscreen/file-text/ooxml';

function zip(parts: Record<string, string>): Uint8Array {
  return zipSync(Object.fromEntries(Object.entries(parts).map(([name, xml]) => [name, strToU8(xml)])));
}

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const A = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"';

describe('decodeXmlEntities', () => {
  it('decodes named and numeric entities', () => {
    expect(decodeXmlEntities('M&amp;M &lt;a&gt; &quot;x&quot; &apos;y&apos; &#252; &#xE4;')).toBe('M&M <a> "x" \'y\' ü ä');
  });

  it('leaves unknown entities alone', () => {
    expect(decodeXmlEntities('&nbsp; &#xZZ;')).toBe('&nbsp; &#xZZ;');
  });
});

describe('extractOoxmlText — Word', () => {
  it('reads body paragraphs, tables, headers, footers, comments and tracked deletions', () => {
    const bytes = zip({
      'word/document.xml': `<?xml version="1.0"?><w:document ${W}><w:body>
        <w:p><w:r><w:t>Dear </w:t></w:r><w:r><w:t xml:space="preserve">Max Mustermann,</w:t></w:r></w:p>
        <w:p><w:r><w:t>Mail: max@example.com</w:t><w:tab/><w:t>Tel</w:t></w:r></w:p>
        <w:tbl><w:tr><w:tc><w:p><w:r><w:t>IBAN</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>DE89 3704 0044 0532 0130 00</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
        <w:p><w:del><w:r><w:delText>Old address: Hauptstr. 1</w:delText></w:r></w:del></w:p>
      </w:body></w:document>`,
      'word/header1.xml': `<w:hdr ${W}><w:p><w:r><w:t>Confidential &amp; internal</w:t></w:r></w:p></w:hdr>`,
      'word/footer2.xml': `<w:ftr ${W}><w:p><w:r><w:t>Page footer</w:t></w:r></w:p></w:ftr>`,
      'word/comments.xml': `<w:comments ${W}><w:comment><w:p><w:r><w:t>Ask Erika Musterfrau</w:t></w:r></w:p></w:comment></w:comments>`,
      'docProps/core.xml': '<cp:coreProperties xmlns:cp="x" xmlns:dc="y"><dc:creator>Jane Author</dc:creator><cp:lastModifiedBy>John Editor</cp:lastModifiedBy></cp:coreProperties>',
      'word/styles.xml': `<w:styles ${W}><w:t>NOT TEXT</w:t></w:styles>`,
    });

    const text = extractOoxmlText(bytes, 'docx');
    expect(text).toContain('Dear Max Mustermann,');
    expect(text).toContain('Mail: max@example.com\tTel');
    expect(text).toContain('DE89 3704 0044 0532 0130 00');
    expect(text).toContain('Old address: Hauptstr. 1');
    expect(text).toContain('Confidential & internal');
    expect(text).toContain('Page footer');
    expect(text).toContain('Ask Erika Musterfrau');
    expect(text).toContain('Jane Author');
    expect(text).toContain('John Editor');
    expect(text).not.toContain('NOT TEXT');
  });

  it('rejects a ZIP that is not a Word document', () => {
    expect(() => extractOoxmlText(zip({ 'foo.xml': '<x/>' }), 'docx')).toThrow(FileTextError);
  });
});

describe('extractOoxmlText — PowerPoint', () => {
  it('reads slides in numeric order plus speaker notes', () => {
    const slide = (text: string) => `<p:sld xmlns:p="p" ${A}><a:p><a:r><a:t>${text}</a:t></a:r></a:p></p:sld>`;
    const bytes = zip({
      'ppt/slides/slide10.xml': slide('Slide ten'),
      'ppt/slides/slide2.xml': slide('Slide two: call +49 30 1234567'),
      'ppt/slides/slide1.xml': slide('Slide one'),
      'ppt/notesSlides/notesSlide1.xml': slide('Speaker note about Anna Schmidt'),
    });

    const text = extractOoxmlText(bytes, 'pptx');
    expect(text.indexOf('Slide one')).toBeLessThan(text.indexOf('Slide two'));
    expect(text.indexOf('Slide two')).toBeLessThan(text.indexOf('Slide ten'));
    expect(text).toContain('+49 30 1234567');
    expect(text).toContain('Speaker note about Anna Schmidt');
  });
});

describe('extractOoxmlText — Excel', () => {
  it('parses shared strings, including rich-text runs, and skips phonetic guides', () => {
    expect(parseSharedStrings(
      '<sst><si><t>plain</t></si><si><r><t>ri</t></r><r><t>ch</t></r></si><si/><si><t>漢字</t><rPh><t>かんじ</t></rPh></si></sst>',
    )).toEqual(['plain', 'rich', '', '漢字']);
  });

  it('renders rows as lines and cells as tab-separated values', () => {
    const sheet = `<worksheet><sheetData>
      <row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>
      <row r="2"><c r="A2" t="inlineStr"><is><t>Inline &lt;name&gt;</t></is></c><c r="B2"><v>4915112345678</v></c><c r="C2" s="1"/></row>
      <row r="3"><c r="A3" t="str"><f>A1</f><v>formula result</v></c></row>
    </sheetData></worksheet>`;
    expect(sheetXmlToText(sheet, ['Name', 'Phone'])).toBe('Name\tPhone\nInline <name>\t4915112345678\nformula result');
  });

  it('reads every worksheet and comment of a workbook', () => {
    const bytes = zip({
      'xl/sharedStrings.xml': '<sst><si><t>Email</t></si><si><t>lisa@example.org</t></si></sst>',
      'xl/worksheets/sheet1.xml': '<worksheet><sheetData><row><c t="s"><v>0</v></c><c t="s"><v>1</v></c></row></sheetData></worksheet>',
      'xl/worksheets/sheet2.xml': '<worksheet><sheetData><row><c t="inlineStr"><is><t>Hidden sheet value</t></is></c></row></sheetData></worksheet>',
      'xl/comments1.xml': '<comments><commentList><comment><text><r><t>Reviewed by Paul</t></r></text></comment></commentList></comments>',
    });

    const text = extractOoxmlText(bytes, 'xlsx');
    expect(text).toContain('Email\tlisa@example.org');
    expect(text).toContain('Hidden sheet value');
    expect(text).toContain('Reviewed by Paul');
  });
});

describe('extractOoxmlText — unreadable input', () => {
  it('reports a password-protected / legacy compound file as encrypted', () => {
    const cfb = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0, 0]);
    expect(() => extractOoxmlText(cfb, 'docx')).toThrow(expect.objectContaining({ code: 'encrypted' }));
  });

  it('reports garbage as corrupt', () => {
    expect(() => extractOoxmlText(new Uint8Array([1, 2, 3, 4]), 'xlsx')).toThrow(expect.objectContaining({ code: 'corrupt' }));
  });
});
