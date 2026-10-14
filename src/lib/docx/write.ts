// A Markdown note made into a Word document (.docx). Headings, emphasis,
// lists, quotes, code, tables and links are Word's own; formulas ($…$ and
// $$…$$) are Word's own formulas (see omml.ts), so the document can go on
// being worked on in Word. The text is set in the app's text face (Times
// New Roman, Song for Chinese). Images are not carried into the document:
// each is named where it stood.
//
// Everything is written here, part by part, as the format describes it;
// nothing of the note is ever read as markup: every piece of its text goes
// through the escaping below.

import JSZip from 'jszip';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import type { Root, RootContent, PhrasingContent, List, Table, AlignType } from 'mdast';
import { latexToOmml } from './omml';

const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const R_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const M_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/math';
const HYPERLINK = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink';

/** Text as XML may hold it: escaped, and without the control characters XML does not allow. */
// eslint-disable-next-line no-control-regex -- these are exactly the characters XML 1.0 cannot hold
const xml = (text: string) => text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

interface Marks { bold?: boolean; italic?: boolean; strike?: boolean; code?: boolean; link?: boolean }

/** One run of text with its marks. Tabs are Word's tabs; a line ending inside a paragraph is a space, as in Markdown. */
function textRun(text: string, marks: Marks): string {
  const props = [
    marks.code ? '<w:rStyle w:val="CodeChar"/>' : marks.link ? '<w:rStyle w:val="Hyperlink"/>' : '',
    marks.bold ? '<w:b/>' : '',
    marks.italic ? '<w:i/>' : '',
    marks.strike ? '<w:strike/>' : '',
  ].join('');
  const pieces = text.replace(/\r?\n/g, ' ').split('\t');
  const body = pieces.map((p, i) => `${i > 0 ? '<w:tab/>' : ''}${p ? `<w:t xml:space="preserve">${xml(p)}</w:t>` : ''}`).join('');
  return body ? `<w:r>${props ? `<w:rPr>${props}</w:rPr>` : ''}${body}</w:r>` : '';
}

interface Writer {
  links: string[];
  /** a numbering instance for each ordered list, so that each starts again */
  orderedLists: number[];
}

function phrasing(nodes: PhrasingContent[], marks: Marks, w: Writer): string {
  let out = '';
  for (const node of nodes) {
    switch (node.type) {
      case 'text': out += textRun(node.value, marks); break;
      case 'strong': out += phrasing(node.children, { ...marks, bold: true }, w); break;
      case 'emphasis': out += phrasing(node.children, { ...marks, italic: true }, w); break;
      case 'delete': out += phrasing(node.children, { ...marks, strike: true }, w); break;
      case 'inlineCode': out += textRun(node.value, { ...marks, code: true }); break;
      case 'break': out += '<w:r><w:br/></w:r>'; break;
      case 'link': {
        w.links.push(node.url);
        out += `<w:hyperlink r:id="rIdLink${w.links.length}">${phrasing(node.children, { ...marks, link: true }, w)}</w:hyperlink>`;
        break;
      }
      case 'image': out += textRun(`[${node.alt || node.url}]`, { ...marks, italic: true }); break;
      case 'html': out += textRun(node.value, marks); break;
      case 'footnoteReference': out += textRun(`[^${node.identifier}]`, marks); break;
      default: {
        // the formula in the line (remark-math's inlineMath): Word's own formula
        const maybe = node as unknown as { type: string; value?: string; children?: PhrasingContent[] };
        if (maybe.type === 'inlineMath' && typeof maybe.value === 'string') out += latexToOmml(maybe.value);
        else if (maybe.children) out += phrasing(maybe.children, marks, w);
        else if (typeof maybe.value === 'string') out += textRun(maybe.value, marks);
      }
    }
  }
  return out;
}

const paragraph = (props: string, body: string) => `<w:p>${props ? `<w:pPr>${props}</w:pPr>` : ''}${body}</w:p>`;
const style = (name: string) => `<w:pStyle w:val="${name}"/>`;
const JUSTIFY: Record<string, string> = { left: 'left', right: 'right', center: 'center' };

function table(node: Table, w: Writer): string {
  const columns = Math.max(1, ...node.children.map((r) => r.children.length));
  const align = (i: number): AlignType | undefined => node.align?.[i] ?? undefined;
  const rows = node.children.map((row, r) => `<w:tr>${row.children.map((cell, c) => {
    const justify = align(c) ? `<w:jc w:val="${JUSTIFY[align(c)!] ?? 'left'}"/>` : '';
    return `<w:tc><w:tcPr><w:tcW w:w="0" w:type="auto"/></w:tcPr>${paragraph(justify, phrasing(cell.children, r === 0 ? { bold: true } : {}, w) || '')}</w:tc>`;
  }).join('')}</w:tr>`).join('');
  return `<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="0" w:type="auto"/></w:tblPr><w:tblGrid>${'<w:gridCol/>'.repeat(columns)}</w:tblGrid>${rows}</w:tbl>`;
}

/** Blocks: `quoted` sets everything in the Quote style; `list` numbers the first paragraph of each item. */
function blocks(nodes: RootContent[], w: Writer, ctx: { quoted?: boolean; list?: { numId: number; level: number } } = {}): string {
  let out = '';
  for (const node of nodes) {
    const base = ctx.quoted ? style('Quote') : '';
    switch (node.type) {
      case 'heading': out += paragraph(style(`Heading${Math.min(6, node.depth)}`), phrasing(node.children, {}, w)); break;
      case 'paragraph': out += paragraph(base, phrasing(node.children, {}, w)); break;
      case 'thematicBreak': out += paragraph('<w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="auto"/></w:pBdr>', ''); break;
      case 'blockquote': out += blocks(node.children, w, { ...ctx, quoted: true }); break;
      case 'code': out += node.value.split('\n').map((line) => paragraph(style('Code'), textRun(line, {}))).join(''); break;
      case 'html': out += paragraph(base, textRun(node.value, {})); break;
      case 'table': out += table(node, w); break;
      case 'list': out += list(node, w, ctx); break;
      case 'definition': case 'footnoteDefinition': break;
      default: {
        // the formula on lines of its own (remark-math's math)
        const maybe = node as unknown as { type: string; value?: string; children?: RootContent[] };
        if (maybe.type === 'math' && typeof maybe.value === 'string') out += paragraph('', `<m:oMathPara>${latexToOmml(maybe.value)}</m:oMathPara>`);
        else if (maybe.children) out += blocks(maybe.children, w, ctx);
      }
    }
  }
  return out;
}

function list(node: List, w: Writer, ctx: { quoted?: boolean; list?: { numId: number; level: number } }): string {
  const level = ctx.list ? ctx.list.level + 1 : 0;
  let numId = 1; // the bullets
  if (node.ordered) {
    w.orderedLists.push(node.start ?? 1);
    numId = 1 + w.orderedLists.length;
  }
  let out = '';
  for (const item of node.children) {
    item.children.forEach((child, i) => {
      if (child.type === 'paragraph' && i === 0) {
        const check = item.checked === true ? '☑ ' : item.checked === false ? '☐ ' : '';
        out += paragraph(`${style('ListParagraph')}<w:numPr><w:ilvl w:val="${Math.min(8, level)}"/><w:numId w:val="${numId}"/></w:numPr>`, textRun(check, {}) + phrasing(child.children, {}, w));
      } else if (child.type === 'list') {
        out += list(child, w, { ...ctx, list: { numId, level } });
      } else {
        out += blocks([child], w, { ...ctx, list: { numId, level } }).replace(/<w:p>(?!<w:pPr>)/g, `<w:p><w:pPr><w:ind w:left="${720 * (level + 1)}"/></w:pPr>`);
      }
    });
  }
  return out;
}

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="${W_NS}">
<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:eastAsia="SimSun" w:cs="Times New Roman"/><w:sz w:val="24"/><w:szCs w:val="24"/><w:lang w:val="en-US" w:eastAsia="zh-CN"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="300" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>
${[1, 2, 3, 4, 5, 6].map((n) => `<w:style w:type="paragraph" w:styleId="Heading${n}"><w:name w:val="heading ${n}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="${n <= 2 ? 360 : 240}" w:after="120"/><w:outlineLvl w:val="${n - 1}"/></w:pPr><w:rPr><w:b/><w:sz w:val="${[36, 32, 28, 26, 24, 24][n - 1]}"/></w:rPr></w:style>`).join('\n')}
<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:ind w:left="720" w:right="720"/></w:pPr><w:rPr><w:i/><w:color w:val="595959"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Code"><w:name w:val="Code"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/><w:shd w:val="clear" w:color="auto" w:fill="F4F2EE"/></w:pPr><w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:eastAsia="SimSun" w:cs="Consolas"/><w:sz w:val="20"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:after="60"/></w:pPr></w:style>
<w:style w:type="character" w:styleId="CodeChar"><w:name w:val="Code Char"/><w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:cs="Consolas"/><w:sz w:val="21"/><w:shd w:val="clear" w:color="auto" w:fill="F4F2EE"/></w:rPr></w:style>
<w:style w:type="character" w:styleId="Hyperlink"><w:name w:val="Hyperlink"/><w:rPr><w:color w:val="0563C1"/><w:u w:val="single"/></w:rPr></w:style>
<w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/><w:tblPr><w:tblBorders><w:top w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:left w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:bottom w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:right w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:insideH w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:insideV w:val="single" w:sz="4" w:space="0" w:color="auto"/></w:tblBorders><w:tblCellMar><w:left w:w="108" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style>
</w:styles>`;

function numbering(orderedStarts: number[]): string {
  const levels = (format: 'bullet' | 'decimal') => Array.from({ length: 9 }, (_, i) => {
    const text = format === 'bullet' ? ['•', '◦', '▪'][i % 3] : `%${i + 1}.`;
    return `<w:lvl w:ilvl="${i}"><w:start w:val="1"/><w:numFmt w:val="${format === 'bullet' ? 'bullet' : ['decimal', 'lowerLetter', 'lowerRoman'][i % 3]}"/><w:lvlText w:val="${text}"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="${720 * (i + 1)}" w:hanging="360"/></w:pPr></w:lvl>`;
  }).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:numbering xmlns:w="${W_NS}">
<w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="hybridMultilevel"/>${levels('bullet')}</w:abstractNum>
<w:abstractNum w:abstractNumId="1"><w:multiLevelType w:val="hybridMultilevel"/>${levels('decimal')}</w:abstractNum>
<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>
${orderedStarts.map((start, i) => `<w:num w:numId="${i + 2}"><w:abstractNumId w:val="1"/><w:lvlOverride w:ilvl="0"><w:startOverride w:val="${start}"/></w:lvlOverride></w:num>`).join('\n')}
</w:numbering>`;
}

/** The note as the bytes of a .docx. `title` goes into the document's properties. */
export async function markdownToDocx(markdown: string, { title = '' }: { title?: string } = {}): Promise<Uint8Array> {
  const tree = unified().use(remarkParse).use(remarkGfm).use(remarkMath).parse(markdown) as Root;
  const w: Writer = { links: [], orderedLists: [] };
  const body = blocks(tree.children, w);
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="${W_NS}" xmlns:r="${R_NS}" xmlns:m="${M_NS}"><w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr></w:body></w:document>`;
  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
<Relationship Id="rIdNumbering" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>
${w.links.map((url, i) => `<Relationship Id="rIdLink${i + 1}" Type="${HYPERLINK}" Target="${xml(url)}" TargetMode="External"/>`).join('\n')}
</Relationships>`;
  const zip = new JSZip();
  zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>
<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
</Types>`);
  zip.file('_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>`);
  zip.file('docProps/core.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${xml(title)}</dc:title><dcterms:created xsi:type="dcterms:W3CDTF">${new Date().toISOString().replace(/\.\d+Z$/, 'Z')}</dcterms:created></cp:coreProperties>`);
  zip.file('docProps/app.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>ThoughtDAG</Application></Properties>`);
  zip.file('word/document.xml', document);
  zip.file('word/styles.xml', STYLES);
  zip.file('word/numbering.xml', numbering(w.orderedLists));
  zip.file('word/_rels/document.xml.rels', rels);
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
}
