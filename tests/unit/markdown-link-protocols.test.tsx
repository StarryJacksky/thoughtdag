import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { HighlightedMarkdown, Markdown } from '../../src/components/Markdown';

const blocked = [
  'irc://chat.example.test/room', 'ircs://chat.example.test/room', 'xmpp:reader@example.test',
  'IRC://chat.example.test/room', 'IrCs://chat.example.test/room', 'XMPP:reader@example.test',
  'smb://example.test/share', 'ssh://example.test', 'file:///synthetic/note.md',
  'javascript:alert(1)', 'data:text/plain,example',
];
const allowed = [
  'http://example.test/page', 'https://example.test/page',
  'mailto:reader@example.test', '/synthetic/note.md', './note.md', '~/note.md', '#section',
];

describe('Markdown link protocols', () => {
  for (const renderer of ['normal', 'highlighted'] as const) {
    for (const syntax of ['markdown', 'html'] as const) {
      it(`${renderer} ${syntax} links keep web, mail and local paths but strip app protocols`, () => {
        // The real sanitizer must remove hrefs while keeping the label.
        // Removing protocols.href from our schema must fail each case.
        for (const [urls, clickable] of [[blocked, false], [allowed, true]] as const) {
          for (const url of urls) {
            // Raw HTML entities must not bypass the same protocol policy.
            const link = syntax === 'markdown' ? `[Reference](<${url}>)`
              : `<a href="${url.replace(':', '&#58;')}">Reference</a>`;
            const content = `Selected passage\n\n${link}`;
            const html = renderToStaticMarkup(renderer === 'normal'
              ? <Markdown>{content}</Markdown>
              : <HighlightedMarkdown content={content} highlights={new Set(['Selected passage'])} />);
            const container = document.createElement('div');
            container.innerHTML = html;
            expect(container.textContent?.replace('Selected passage', '').trim(), url).toBe('Reference');
            if (renderer === 'highlighted') expect(container.querySelector('mark')?.textContent).toBe('Selected passage');
            expect([...container.querySelectorAll('a[href]')].map((a) => a.getAttribute('href')), url)
              .toEqual(clickable ? [url] : []);
            if (url === '/synthetic/note.md' || url === '~/note.md') {
              expect(container.querySelector('a')?.getAttribute('data-local-path')).toBe(url);
            }
          }
        }
      });
    }
  }
});
