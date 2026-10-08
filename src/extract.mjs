// Language-agnostic extraction: definitions come from keyword patterns shared by most
// languages plus a few per-family extras; references are plain identifier occurrences.

const MODIFIERS = 'export|default|declare|pub(?:\\([^)]*\\))?|public|private|protected|internal|static|final|abstract|async|unsafe|override|open|sealed|data|inline|virtual|extern|const|partial';
const KEYWORDS = 'function\\*?|func|fn|fun|def|defp|defmodule|defmacro|class|struct|interface|trait|enum|module|mod|type|protocol|object|record|namespace|sub|proc|procedure|contract|message|service';

// e.g. `export async function foo(`, `func (s *Server) Start(`, `def self.build`, `function M.run(`
const GENERIC = new RegExp(
  `^[ \\t]*(?:(?:${MODIFIERS})\\s+)*(${KEYWORDS})\\s+(?:\\([^)\\n]*\\)\\s*)?(?:[\\w$]+[.:]+)*([A-Za-z_$][\\w$]*)`, 'gm');

// Top level only: indented bindings are locals, which other files cannot reference.
const JS_BINDING = /^(?:export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)|(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=\n]+)?=\s*(?:async\s+)?(?:function\b|\([^)\n]*\)\s*(?::[^=\n]+)?=>|[A-Za-z_$][\w$]*\s*=>))/gm;
// `ReturnType name(args) {` with no trailing semicolon
const C_FUNCTION = /^[ \t]*(?:[A-Za-z_][\w:<>\[\],*&?.]*[ \t]+)+[*&]*([A-Za-z_]\w*)[ \t]*\([^;{}]*\)[ \t]*(?:const[ \t]*)?(?:throws[ \t][\w., ]+)?\{?[ \t]*$/gm;
const C_DEFINE = /^#[ \t]*define[ \t]+([A-Za-z_]\w*)/gm;
const SHELL_FUNCTION = /^[ \t]*([A-Za-z_][\w-]*)[ \t]*\(\)[ \t]*\{?/gm;
const SQL_OBJECT = /^[ \t]*create\s+(?:or\s+replace\s+)?(?:table|view|function|procedure|type)\s+(?:if\s+not\s+exists\s+)?(?:[\w"`]+\.)?["`]?([A-Za-z_]\w*)/gim;
const RUST_MACRO = /^[ \t]*macro_rules!\s+([A-Za-z_]\w*)/gm;

const JS_FAMILY = new Set(['javascript', 'typescript', 'vue', 'svelte', 'astro']);
const C_FAMILY = new Set(['c', 'cpp', 'objc', 'java', 'csharp', 'dart', 'groovy', 'solidity']);

const EXTRAS = (lang) => {
  if (JS_FAMILY.has(lang)) return [[JS_BINDING, 'const']];
  if (C_FAMILY.has(lang)) return [[C_FUNCTION, 'function'], ...(lang === 'c' || lang === 'cpp' ? [[C_DEFINE, 'macro']] : [])];
  if (lang === 'shell') return [[SHELL_FUNCTION, 'function']];
  if (lang === 'sql') return [[SQL_OBJECT, 'object']];
  if (lang === 'rust') return [[RUST_MACRO, 'macro']];
  return [];
};

const NOT_NAMES = new Set([
  'if', 'else', 'for', 'while', 'switch', 'catch', 'return', 'new', 'throw', 'case', 'do', 'try',
  'sizeof', 'typeof', 'delete', 'await', 'yield', 'function', 'class', 'var', 'let', 'const',
  'self', 'this', 'super', 'null', 'true', 'false', 'of', 'in', 'is', 'as', 'and', 'or', 'not',
]);

const IDENT = /[A-Za-z_$][\w$]{2,}/g;

function lineIndex(text) {
  const starts = [0];
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) starts.push(i + 1);
  return (offset) => {
    let lo = 0, hi = starts.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= offset) lo = mid; else hi = mid - 1; }
    return lo + 1;
  };
}

function signature(text, offset) {
  const end = text.indexOf('\n', offset);
  const line = text.slice(offset, end === -1 ? text.length : end).trim().replace(/\s+/g, ' ').replace(/\s*[{:]$/, '');
  return line.length > 110 ? `${line.slice(0, 107)}...` : line;
}

export function extract(text, lang) {
  const lineOf = lineIndex(text);
  const seen = new Set();
  const defs = [];
  const add = (m, name, kind) => {
    if (!name || NOT_NAMES.has(name)) return;
    const line = lineOf(m.index);
    const key = `${name}:${line}`;
    if (seen.has(key)) return;
    const sig = signature(text, m.index);
    if (kind === 'type' && sig.endsWith(',')) return; // `type Foo,` inside an import list
    seen.add(key);
    defs.push({ name, kind, line, sig });
  };

  GENERIC.lastIndex = 0;
  const js = JS_FAMILY.has(lang);
  for (let m; (m = GENERIC.exec(text));) {
    // An indented `function` in JavaScript is a local helper, invisible to other files.
    if (js && m[1].startsWith('function') && /^[ \t]/.test(m[0])) continue;
    add(m, m[2], m[1]);
  }
  for (const [re, kind] of EXTRAS(lang)) {
    re.lastIndex = 0;
    for (let m; (m = re.exec(text));) add(m, m[1] ?? m[2], kind);
  }
  defs.sort((a, b) => a.line - b.line);

  const idents = new Map();
  for (const id of text.match(IDENT) ?? []) idents.set(id, (idents.get(id) ?? 0) + 1);
  return { defs, idents };
}
