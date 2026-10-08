import { EXPLICIT } from './imports.mjs';

// A name defined in more files than this is too ambiguous to say which file a reference means.
const MAX_DEFINERS = 5;
// Names that appear everywhere as ordinary words, tags or entry points, so a match says nothing.
const GENERIC_NAMES = new Set([
  'main', 'config', 'init', 'setup', 'run', 'start', 'stop', 'test', 'index', 'handler', 'default',
  'get', 'set', 'add', 'update', 'create', 'delete', 'remove', 'name', 'type', 'value', 'data',
  'error', 'options', 'props', 'state', 'render', 'toString', 'constructor', 'metadata',
]);
// A reference backed by an import outweighs one inferred from a shared name.
const IMPORT_BOOST = 5;

// files: [{ path, lang, defs, idents, imports, packageImports }].
// An edge a -> b means "a uses a symbol defined in b" or "a imports b".
export function buildGraph(files) {
  const definers = new Map();
  files.forEach((f, i) => {
    for (const d of f.defs) {
      if (!definers.has(d.name)) definers.set(d.name, new Set());
      definers.get(d.name).add(i);
    }
  });

  // Where imports resolve, they are the only evidence accepted for that language.
  const resolvedLangs = new Set(files.filter((f) => f.imports.size).map((f) => f.lang));
  const strict = (f) => EXPLICIT.has(f.lang) && resolvedLangs.has(f.lang);

  const out = files.map(() => new Map()); // target index -> { weight, names }
  const inc = files.map(() => new Map()); // source index -> names
  const symbolUsers = files.map(() => new Map()); // name -> number of other files using it

  const link = (from, to, weight, name) => {
    const edge = out[from].get(to) ?? { weight: 0, names: new Set() };
    edge.weight += weight;
    out[from].set(to, edge);
    if (!inc[to].has(from)) inc[to].set(from, new Set());
    if (!name) return;
    edge.names.add(name);
    inc[to].get(from).add(name);
    symbolUsers[to].set(name, (symbolUsers[to].get(name) ?? 0) + 1);
  };

  files.forEach((f, i) => {
    for (const [name, count] of f.idents) {
      const targets = definers.get(name);
      if (!targets || targets.has(i)) continue;
      const imported = [...targets].filter((t) => f.imports.has(t) || f.packageImports.has(t));
      if (imported.length) {
        for (const t of imported) link(i, t, (Math.sqrt(count) * IMPORT_BOOST) / imported.length, name);
        continue;
      }
      if (strict(f) || GENERIC_NAMES.has(name) || targets.size > MAX_DEFINERS) continue;
      for (const t of targets) if (!strict(files[t])) link(i, t, Math.sqrt(count) / targets.size, name);
    }
    for (const t of f.imports) if (!out[i].has(t)) link(i, t, 1, null);
  });

  return { out, inc, symbolUsers, definers, rank: pageRank(out) };
}

function pageRank(out, damping = 0.85, iterations = 30) {
  const n = out.length;
  if (!n) return [];
  const totals = out.map((edges) => { let s = 0; for (const e of edges.values()) s += e.weight; return s; });
  let rank = new Array(n).fill(1 / n);
  for (let it = 0; it < iterations; it++) {
    const next = new Array(n).fill((1 - damping) / n);
    let dangling = 0;
    for (let i = 0; i < n; i++) {
      if (!totals[i]) { dangling += rank[i]; continue; }
      for (const [t, e] of out[i]) next[t] += damping * rank[i] * (e.weight / totals[i]);
    }
    const share = (damping * dangling) / n;
    for (let i = 0; i < n; i++) next[i] += share;
    rank = next;
  }
  return rank;
}
