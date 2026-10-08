import { readFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { LANGS, listFiles } from './scan.mjs';
import { extract } from './extract.mjs';
import { importSpecs, resolveImports } from './imports.mjs';
import { buildGraph } from './graph.mjs';

export function analyze(root) {
  const { files: paths, truncated } = listFiles(root);
  const files = [];
  for (const path of paths) {
    let text;
    try { text = readFileSync(join(root, path), 'utf8'); } catch { continue; }
    if (text.includes('\u0000')) continue;
    const lang = LANGS[extname(path)];
    files.push({ path, lang, ...extract(text, lang), specs: importSpecs(text, lang) });
  }
  resolveImports(files);
  return { files, truncated, graph: buildGraph(files) };
}
