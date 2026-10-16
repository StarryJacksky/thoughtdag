// What a file means, as against how it happens to be laid out: for a mind
// map (.tdmap), its content without its layout (where its nodes are drawn,
// which are folded), in one canonical form. Moving a mind map's nodes about
// changes its bytes and not what it says, and an answer that read it is not
// out of date for that. Any other file means what it holds.
//
// Imported by the context builder, so it imports nothing.

export const MINDMAP_MEDIA_TYPE = 'application/vnd.thoughtdag.mindmap+json';

/** Whether a file is a mind map, by its name or its media type. */
export const isMindMap = (nameOrType: string | undefined | null): boolean =>
  !!nameOrType && (nameOrType === MINDMAP_MEDIA_TYPE || /\.tdmap$/i.test(nameOrType));

/** JSON with its object keys sorted, arrays in their order. */
function sortedJson(value: unknown): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort);
    if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, sort((v as Record<string, unknown>)[k])]));
    return v;
  };
  return JSON.stringify(sort(value));
}

/** A mind map's text without its layout, in canonical form; text that is not a mind map as it is. */
export function meaningOf(text: string): string {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || (parsed as { format?: unknown }).format !== 'thoughtdag-mindmap') return text;
    const rest = { ...(parsed as Record<string, unknown>) };
    delete rest.layout;
    return sortedJson(rest);
  } catch {
    return text;
  }
}
