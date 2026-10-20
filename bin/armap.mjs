#!/usr/bin/env node
import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyze } from '../src/analyze.mjs';
import { renderDeps, renderMap, renderRefs } from '../src/render.mjs';

const USAGE = `Usage: armap <command> [options]

  map                 Print a ranked, token-budgeted map of the repository
  deps <file>         Show what a file uses and what uses it
  refs <symbol>       Show where a symbol is defined and which files reference it

Options:
  --root <dir>        Repository root (default: $CLAUDE_PROJECT_DIR or the current directory)
  --budget <tokens>   Approximate size limit for "map" (default: 1500)
  --hook              Never fail and print nothing when there is nothing to map`;

function parseArgs(argv) {
  const opts = { positional: [], budget: 1500, hook: false, root: process.env.CLAUDE_PROJECT_DIR || process.cwd() };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--root') opts.root = argv[++i];
    else if (a === '--budget') opts.budget = Number(argv[++i]);
    else if (a === '--hook') opts.hook = true;
    else if (a === '-h' || a === '--help') opts.help = true;
    else opts.positional.push(a);
  }
  return opts;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const [command, arg] = opts.positional;
  if (opts.help || !command) { console.log(USAGE); return; }
  if (!Number.isFinite(opts.budget) || opts.budget <= 0) throw new Error('--budget must be a positive number');
  if (!['map', 'deps', 'refs'].includes(command)) throw new Error(`Unknown command "${command}"\n\n${USAGE}`);
  if (command === 'deps' && !arg) throw new Error('deps needs a file path');
  if (command === 'refs' && !arg) throw new Error('refs needs a symbol name');

  const root = resolve(opts.root);
  const { files, truncated, graph } = analyze(root);
  if (!files.length) {
    if (!opts.hook) console.log(`No source files found under ${root}`);
    return;
  }

  if (command === 'map') {
    const queryCommand = `node "${fileURLToPath(import.meta.url)}"`;
    console.log(renderMap({ files, graph, budget: opts.budget, truncated, queryCommand }));
  } else if (command === 'deps') {
    const rel = relative(root, resolve(root, arg)).split('\\').join('/');
    let index = files.findIndex((f) => f.path === rel);
    if (index === -1) {
      const matches = files.map((f, i) => [f, i]).filter(([f]) => f.path.endsWith(`/${arg}`) || f.path.endsWith(arg));
      if (matches.length !== 1) throw new Error(matches.length ? `"${arg}" is ambiguous: ${matches.slice(0, 5).map(([f]) => f.path).join(', ')}` : `"${arg}" is not a mapped source file`);
      index = matches[0][1];
    }
    console.log(renderDeps({ files, graph, index }));
  } else if (command === 'refs') {
    console.log(renderRefs({ files, graph, name: arg }));
  }
}

try {
  main();
} catch (err) {
  const hook = process.argv.includes('--hook');
  if (!hook) console.error(err.message);
  process.exitCode = hook ? 0 : 1;
}
