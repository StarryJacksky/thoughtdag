import { isWebUrl } from '../../shared/web-url.mjs';
import type { Reference, ThoughtNode } from '../types';

/** Keep citation positions intact: an unsafe source still has a title. */
export function sanitizeReferenceUrls(references: Reference[] | undefined): Reference[] | undefined {
  return references?.map((reference) => ({
    ...reference,
    url: isWebUrl(reference.url) ? reference.url : undefined,
  }));
}

/** Sanitize data URLs without rewriting prose or mutating incoming nodes. */
export function sanitizeNodeLinkUrls(node: ThoughtNode): ThoughtNode {
  return {
    ...node,
    data: {
      ...node.data,
      linkUrl: isWebUrl(node.data.linkUrl) ? node.data.linkUrl : undefined,
      references: sanitizeReferenceUrls(node.data.references),
    },
  };
}
