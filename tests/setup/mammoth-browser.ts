// The Word reader as the app's own build resolves it. The package ships a
// build for browsers (it takes the bytes of a document as an ArrayBuffer)
// and one for Node (it wants a path or a Buffer); the app's bundler picks
// the first. The tests run on Node, where a plain import would pick the
// second, and every document handed over as an ArrayBuffer would fail with
// "Could not find file in options" whatever it held. This points the
// import at the build the app really uses.
// @ts-expect-error the browser bundle has no type declarations of its own
import mammoth from 'mammoth/mammoth.browser.js';

export const extractRawText: typeof import('mammoth').extractRawText = mammoth.extractRawText;
export const convertToHtml: typeof import('mammoth').convertToHtml = mammoth.convertToHtml;
export default mammoth as typeof import('mammoth');
