// Rough estimate; paths and code run denser than prose, so this errs on the high side.
export const estimateTokens = (text) => Math.ceil(text.length / 3.5);

const SYMBOLS_PER_FILE = 6;
const LIST_LIMIT = 25;

function counts(items) {
  const m = new Map();
  for (const it of items) m.set(it, (m.get(it) ?? 0) + 1);
  return [...m].sort((a, b) => b[1] - a[1]);
}

export function renderMap({ files, graph, budget, truncated, queryCommand }) {
  const langs = counts(files.map((f) => f.lang)).slice(0, 6).map(([l, n]) => `${l} ${n}`).join(', ');
  const dirs = counts(files.map((f) => (f.path.includes('/') ? `${f.path.split('/')[0]}/` : './')))
    .slice(0, 12).map(([d, n]) => `${d} ${n}`).join(', ');

  const head = [
    `# Repo map: ${files.length}${truncated ? '+' : ''} source files (${langs})`,
    `Top-level: ${dirs}`,
    'Files below are ranked by how much other code depends on them. `L<n>` is the line of each definition.',
    '',
  ];
  const tail = ['', `Query before reading files: ${queryCommand} deps <file> | refs <symbol> | map --budget <tokens>`];

  const order = files.map((_, i) => i).sort((a, b) => graph.rank[b] - graph.rank[a]);
  const body = [];
  let used = estimateTokens([...head, ...tail].join('\n'));
  let shown = 0;
  for (const i of order) {
    const f = files[i];
    const users = graph.symbolUsers[i];
    const symbols = [...f.defs]
      .sort((a, b) => (users.get(b.name) ?? 0) - (users.get(a.name) ?? 0) || a.line - b.line)
      .slice(0, SYMBOLS_PER_FILE)
      .sort((a, b) => a.line - b.line);
    const usedBy = graph.inc[i].size;
    const entry = [`${f.path}${usedBy ? ` (used by ${usedBy})` : ''}`, ...symbols.map((s) => `  L${s.line} ${s.sig}`)];
    const cost = estimateTokens(entry.join('\n')) + 1;
    if (used + cost > budget) break;
    body.push(...entry);
    used += cost;
    shown++;
  }
  if (shown < files.length) body.push(`... ${files.length - shown} more files not shown`);
  return [...head, ...body, ...tail].join('\n');
}

function edgeList(files, entries) {
  const lines = entries.slice(0, LIST_LIMIT).map(([i, names]) => `  ${files[i].path}: ${names.size ? [...names].slice(0, 8).join(', ') : '(import)'}`);
  if (entries.length > LIST_LIMIT) lines.push(`  ... ${entries.length - LIST_LIMIT} more`);
  return lines.length ? lines : ['  (none)'];
}

export function renderDeps({ files, graph, index }) {
  const uses = [...graph.out[index]].sort((a, b) => b[1].weight - a[1].weight).map(([i, e]) => [i, e.names]);
  const usedBy = [...graph.inc[index]].sort((a, b) => b[1].size - a[1].size);
  return [
    files[index].path,
    `uses (${uses.length}):`, ...edgeList(files, uses),
    `used by (${usedBy.length}):`, ...edgeList(files, usedBy),
  ].join('\n');
}

export function renderRefs({ files, graph, name }) {
  const targets = graph.definers.get(name);
  if (!targets) return `No definition of "${name}" found.`;
  const lines = ['defined in:'];
  const users = new Set();
  for (const t of targets) {
    for (const d of files[t].defs) if (d.name === name) lines.push(`  ${files[t].path}:${d.line}  ${d.sig}`);
    for (const [src, names] of graph.inc[t]) if (names.has(name)) users.add(src);
  }
  const sorted = [...users].map((i) => files[i].path).sort();
  lines.push(`referenced by (${sorted.length}):`, ...sorted.slice(0, 40).map((p) => `  ${p}`));
  if (sorted.length > 40) lines.push(`  ... ${sorted.length - 40} more`);
  if (!sorted.length) lines.push('  (none found, or the name is defined in too many files to attribute)');
  return lines.join('\n');
}
