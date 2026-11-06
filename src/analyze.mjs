import { closeSync, openSync, readFileSync, readSync } from 'node:fs';
import { extname, join } from 'node:path';
import { LANGS, MAX_BYTES, listFiles } from './scan.mjs';
import { extract } from './extract.mjs';
import { importSpecs, resolveImports } from './imports.mjs';
import { buildGraph } from './graph.mjs';

// The first MAX_BYTES of a file, cut back to the last full line.
function readHead(path) {
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(MAX_BYTES);
    const text = buf.toString('utf8', 0, readSync(fd, buf, 0, MAX_BYTES, 0));
    const end = text.lastIndexOf('\n');
    return end === -1 ? text : text.slice(0, end + 1);
  } finally {
    closeSync(fd);
  }
}

export function analyze(root) {
  const { files: paths, truncated, large } = listFiles(root);
  const files = [];
  for (const path of paths) {
    const size = large.get(path);
    let text;
    try { text = size ? readHead(join(root, path)) : readFileSync(join(root, path), 'utf8'); } catch { continue; }
    if (text.includes('\u0000')) continue;
    const lang = LANGS[extname(path)];
    const file = { path, lang, ...extract(text, lang), specs: importSpecs(text, lang) };
    if (size) file.partialOf = size;
    files.push(file);
  }
  resolveImports(files);
  return { files, truncated, graph: buildGraph(files) };
}
