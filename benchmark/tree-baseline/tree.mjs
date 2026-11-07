#!/usr/bin/env node
// Benchmark control for armap. Prints the same source files armap would map, as a plain
// alphabetical tree with no ranking, symbols, line numbers or query commands, capped at the
// same token budget. Comparing against it shows what the ranking adds beyond a file listing.
//
//   node tree.mjs [--root <dir>] [--budget 700]
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listFiles } from '../../src/scan.mjs';
import { estimateTokens } from '../../src/render.mjs';

export function renderTree(paths, budget) {
  const head = [`# File tree: ${paths.length} source files`, ''];
  const lines = [];
  let used = estimateTokens(head.join('\n'));
  let shown = 0;
  let prev = [];
  for (const path of paths) {
    const parts = path.split('/');
    let same = 0;
    while (same < parts.length - 1 && same < prev.length - 1 && parts[same] === prev[same]) same++;
    const entry = [];
    for (let d = same; d < parts.length - 1; d++) entry.push(`${'  '.repeat(d)}${parts[d]}/`);
    entry.push(`${'  '.repeat(parts.length - 1)}${parts[parts.length - 1]}`);
    const cost = estimateTokens(entry.join('\n')) + 1;
    if (used + cost > budget) break;
    lines.push(...entry);
    used += cost;
    shown++;
    prev = parts;
  }
  if (shown < paths.length) lines.push(`... ${paths.length - shown} more files not shown`);
  return [...head, ...lines].join('\n');
}

function main() {
  const args = process.argv.slice(2);
  const opt = (name, fallback) => { const i = args.indexOf(name); return i === -1 ? fallback : args[i + 1]; };
  const root = resolve(opt('--root', process.env.CLAUDE_PROJECT_DIR || process.cwd()));
  const budget = Number(opt('--budget', 700));
  const { files } = listFiles(root);
  if (files.length) console.log(renderTree(files, budget));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch { /* a hook must never fail the session */ }
}
