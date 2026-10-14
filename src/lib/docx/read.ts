// What a Word document says, paragraph by paragraph, with its formulas as
// formulas (Word's OMML, for mathml.ts to draw). Only the document's own
// text and formulas are read: no styles, no images, nothing that runs.
// A table is read a row at a time, its cells apart by tabs.

import JSZip from 'jszip';

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const M = 'http://schemas.openxmlformats.org/officeDocument/2006/math';

export type DocxPart = { kind: 'text'; text: string } | { kind: 'math'; omml: Element; display: boolean };
export interface DocxBlock { parts: DocxPart[] }
export interface DocxContent { hasMath: boolean; blocks: DocxBlock[] }

/** Whether the document has formulas, without reading the rest of it. */
export async function docxHasMath(bytes: Uint8Array): Promise<boolean> {
  const zip = await JSZip.loadAsync(bytes);
  const xml = await zip.file('word/document.xml')?.async('string');
  return !!xml && /<m:oMath[\s>]/.test(xml);
}

export async function readDocx(bytes: Uint8Array): Promise<DocxContent> {
  const zip = await JSZip.loadAsync(bytes);
  const xml = await zip.file('word/document.xml')?.async('string');
  if (!xml) throw new Error('this is not a Word document: it has no document part');
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length > 0) throw new Error('the Word document could not be read');
  const body = doc.getElementsByTagNameNS(W, 'body')[0];
  const blocks: DocxBlock[] = [];
  let hasMath = false;

  const inline = (el: Element, parts: DocxPart[]) => {
    const add = (text: string) => {
      if (!text) return;
      const last = parts[parts.length - 1];
      if (last?.kind === 'text') last.text += text; else parts.push({ kind: 'text', text });
    };
    for (const c of [...el.children]) {
      if (c.namespaceURI === M) {
        if (c.localName === 'oMath') { hasMath = true; parts.push({ kind: 'math', omml: c, display: false }); }
        else if (c.localName === 'oMathPara') for (const m of [...c.getElementsByTagNameNS(M, 'oMath')]) { hasMath = true; parts.push({ kind: 'math', omml: m, display: true }); }
        continue;
      }
      if (c.namespaceURI !== W) continue;
      switch (c.localName) {
        case 't': add(c.textContent ?? ''); break;
        case 'tab': add('\t'); break;
        case 'br': case 'cr': add('\n'); break;
        case 'noBreakHyphen': add('-'); break;
        case 'del': case 'delText': case 'pPr': case 'rPr': case 'instrText': break;
        default: inline(c, parts); // runs, links, fields, insertions, content controls
      }
    }
  };

  const block = (el: Element) => {
    for (const c of [...el.children]) {
      if (c.namespaceURI !== W) continue;
      if (c.localName === 'p') {
        const parts: DocxPart[] = [];
        inline(c, parts);
        blocks.push({ parts });
      } else if (c.localName === 'tbl') {
        for (const row of [...c.children].filter((r) => r.localName === 'tr')) {
          const parts: DocxPart[] = [];
          [...row.children].filter((cell) => cell.localName === 'tc').forEach((cell, i) => {
            if (i > 0) parts.push({ kind: 'text', text: '\t' });
            [...cell.children].filter((p) => p.localName === 'p').forEach((p, j) => {
              if (j > 0) parts.push({ kind: 'text', text: ' ' });
              inline(p, parts);
            });
          });
          blocks.push({ parts });
        }
      } else if (c.localName === 'sdt') {
        const content = [...c.children].find((x) => x.localName === 'sdtContent');
        if (content) block(content);
      }
    }
  };
  if (body) block(body);
  return { hasMath, blocks };
}
