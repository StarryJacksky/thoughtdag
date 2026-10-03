// A file's media type from its name. A label for choosing an editor or a
// reader, never a claim about what the bytes are.
'use strict';

const BY_EXTENSION = {
  md: 'text/markdown',
  markdown: 'text/markdown',
  txt: 'text/plain',
  tex: 'text/x-tex',
  bib: 'text/x-bibtex',
  py: 'text/x-python',
  js: 'text/javascript',
  mjs: 'text/javascript',
  cjs: 'text/javascript',
  ts: 'text/typescript',
  tsx: 'text/typescript',
  jsx: 'text/javascript',
  json: 'application/json',
  yaml: 'application/yaml',
  yml: 'application/yaml',
  csv: 'text/csv',
  html: 'text/html',
  htm: 'text/html',
  tdmap: 'application/vnd.thoughtdag.mindmap+json',
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

function mediaTypeOf(name) {
  const dot = String(name).lastIndexOf('.');
  const extension = dot > 0 ? String(name).slice(dot + 1).toLowerCase() : '';
  return BY_EXTENSION[extension] ?? 'application/octet-stream';
}

module.exports = { mediaTypeOf };
