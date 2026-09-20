/**
 * Produces dist/artifact.html: the built app without its document wrapper.
 *
 * The artifact platform supplies its own <!doctype>, <html>, <head> and <body>
 * — including the charset and viewport meta — and wraps whatever it is given,
 * so publishing a complete document would nest one inside another. This keeps
 * the title, styles, scripts and markup and drops the shell around them.
 *
 * The bundled JavaScript contains document markup of its own (the print sheet
 * builds a whole page in a string), so the wrapper is found by taking the last
 * of each closing tag rather than the first, and the result is checked for the
 * markup the app actually needs.
 */
import { readFile, writeFile } from 'node:fs/promises';

const source = await readFile('dist/index.html', 'utf8');

const headOpen = source.indexOf('<head>');
const headClose = source.lastIndexOf('</head>');
const bodyOpen = source.lastIndexOf('<body');
const bodyClose = source.lastIndexOf('</body>');

if (headOpen < 0 || headClose < headOpen || bodyOpen < headClose || bodyClose < bodyOpen) {
  throw new Error('dist/index.html does not look like a built page — run `npm run build` first.');
}

const head = source
  .slice(headOpen + '<head>'.length, headClose)
  // The platform's own skeleton already declares these.
  .replace(/<meta\s+charset[^>]*>/gi, '')
  .replace(/<meta\s+name=["']viewport["'][^>]*>/gi, '')
  .trim();

const body = source.slice(source.indexOf('>', bodyOpen) + 1, bodyClose).trim();
const out = `${head}\n${body}\n`;

for (const [what, present] of [
  ['<title>', /<title>[^<]+<\/title>/i.test(out)],
  ['the stylesheet', /<style>/i.test(out)],
  ['the application script', /<script type="module"/i.test(out)],
  ['the app shell', out.includes('id="app"')],
  ['the drawing canvas', out.includes('id="canvas"')],
  ['the side panel', out.includes('id="tab-body"')],
]) {
  if (!present) throw new Error(`the unwrapped page is missing ${what}`);
}
if (/^\s*<(!doctype|html\b|head\b|body\b)/i.test(out)) {
  throw new Error('a document tag survived the unwrap');
}

await writeFile('dist/artifact.html', out);
console.log(`dist/artifact.html  ${(Buffer.byteLength(out) / 1024).toFixed(1)} kB`);
