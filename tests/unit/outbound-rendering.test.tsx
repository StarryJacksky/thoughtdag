import { afterEach, describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ReactFlowProvider, type NodeProps } from '@xyflow/react';
import ThoughtNode from '../../src/components/ThoughtNode';
import ContentNode from '../../src/components/ContentNode';
import ResponseSection from '../../src/components/focus-panel/ResponseSection';
import { useStore } from '../../src/store';
import type { ThoughtNode as CanvasNode } from '../../src/types';
import { fixture } from '../fixtures/research';

const urls = [
  'https://example.test/paper', 'http://example.test/paper', 'HTTPS://EXAMPLE.TEST/paper',
  'smb://example.test/share', 'ssh://example.test/repo', 'mailto:reader@example.test',
  'thoughtdag://node/example', 'file:///tmp/example.md', 'data:text/plain,example',
  'javascript:alert(1)', 'irc://example.test/room', 'ircs://example.test/room',
  'xmpp:reader@example.test', '//example.test/paper', '/relative',
  'https://', 'https://bad host/', ' https://example.test/', 'ht\ntps://example.test/',
];

afterEach(() => useStore.setState({ nodes: [], edges: [] }));

describe('stored outbound links are checked at render time', () => {
  for (const site of ['canvas references', 'focus references', 'link card'] as const) {
    it(`${site} keeps web links and renders other destinations as text`, () => {
      // Feed the components directly, as an old IndexedDB canvas would.
      // Removing this site's guard must expose a non-web href again.
      for (const [index, url] of urls.entries()) {
        const node = fixture('single-parent-edited-ancestor').graph.nodes[0];
        node.data.references = [{ title: 'Source title', url }];
        if (site === 'link card') {
          node.data.stepKind = 'link';
          node.data.linkUrl = url;
          node.data.linkTitle = 'Source title';
        }
        useStore.setState({ nodes: [node], edges: [] });
        const props: NodeProps<CanvasNode> = {
          ...node, selected: false, dragging: false, isConnectable: true,
          draggable: true, deletable: true, selectable: true, zIndex: 0,
          positionAbsoluteX: node.position.x, positionAbsoluteY: node.position.y,
        };
        const html = renderToStaticMarkup(
          <ReactFlowProvider>
            {site === 'canvas references' ? <ThoughtNode {...props} />
              : site === 'link card' ? <ContentNode {...props} />
                : <ResponseSection nodeId={node.id} data={node.data} hasMultipleVersions={false}
                    highlightedTexts={new Set()} onExploreSelection={() => {}} />}
          </ReactFlowProvider>,
        );
        const container = document.createElement('div');
        container.innerHTML = html;
        expect(container.textContent, `${site}: ${url}`).toContain('Source title');
        const links = [...container.querySelectorAll('a[href]')];
        expect(links.map((a) => a.getAttribute('href')), `${site}: ${url}`).toEqual(index < 3 ? [url] : []);
      }
    });
  }
});
