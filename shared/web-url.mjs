/** Data-backed outbound links must be absolute web URLs, never app schemes. */
export function isWebUrl(value) {
  if (typeof value !== 'string' || !/^https?:\/\/\S+$/i.test(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}
