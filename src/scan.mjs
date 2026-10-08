import { execFileSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';

export const LANGS = {
  '.js': 'javascript', '.jsx': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript',
  '.ts': 'typescript', '.tsx': 'typescript', '.mts': 'typescript', '.cts': 'typescript',
  '.vue': 'vue', '.svelte': 'svelte', '.astro': 'astro',
  '.py': 'python', '.pyi': 'python',
  '.go': 'go', '.rs': 'rust',
  '.java': 'java', '.kt': 'kotlin', '.kts': 'kotlin', '.scala': 'scala', '.groovy': 'groovy',
  '.c': 'c', '.h': 'c', '.cc': 'cpp', '.cpp': 'cpp', '.cxx': 'cpp', '.hpp': 'cpp', '.hh': 'cpp',
  '.cs': 'csharp', '.fs': 'fsharp', '.vb': 'vb',
  '.m': 'objc', '.mm': 'objc', '.swift': 'swift', '.dart': 'dart',
  '.rb': 'ruby', '.php': 'php', '.pl': 'perl', '.pm': 'perl', '.lua': 'lua', '.r': 'r', '.R': 'r',
  '.ex': 'elixir', '.exs': 'elixir', '.erl': 'erlang', '.hs': 'haskell', '.ml': 'ocaml',
  '.clj': 'clojure', '.cljs': 'clojure', '.jl': 'julia', '.zig': 'zig', '.nim': 'nim',
  '.sh': 'shell', '.bash': 'shell', '.zsh': 'shell', '.ps1': 'powershell',
  '.sql': 'sql', '.proto': 'protobuf', '.graphql': 'graphql', '.gql': 'graphql',
  '.sol': 'solidity', '.tf': 'terraform',
};

const SKIP_DIRS = new Set([
  '.git', 'node_modules', 'vendor', 'dist', 'build', 'out', 'target', 'coverage',
  '.next', '.nuxt', '.venv', 'venv', '__pycache__', '.idea', '.vscode', 'Pods',
  '.gradle', '.dart_tool', 'bower_components',
]);

export const MAX_FILES = 5000;
const MAX_BYTES = 256 * 1024;

function wanted(rel) {
  if (!(extname(rel) in LANGS)) return false;
  if (/\.(min|bundle)\.[cm]?js$|\.d\.ts$|\.generated\.|_pb2?\.|\.pb\.go$/.test(rel)) return false;
  return !rel.split('/').some((part) => SKIP_DIRS.has(part));
}

function gitFiles(root) {
  const out = execFileSync('git', ['ls-files', '-co', '--exclude-standard', '-z'], {
    cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'],
  });
  return out.split('\0').filter(Boolean);
}

function walk(root) {
  const found = [];
  const stack = [''];
  while (stack.length && found.length <= MAX_FILES) {
    const dir = stack.pop();
    let entries;
    try { entries = readdirSync(join(root, dir), { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (e.name.startsWith('.') && e.isDirectory()) continue;
      const rel = dir ? `${dir}/${e.name}` : e.name;
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) stack.push(rel); }
      else if (e.isFile() && wanted(rel)) found.push(rel);
    }
  }
  return found;
}

// Source files under root, as posix-style relative paths. Honors .gitignore when root is in a git repo.
export function listFiles(root) {
  let rels;
  try { rels = gitFiles(root).filter(wanted); } catch { rels = walk(root); }
  rels = rels.filter((rel) => {
    try { const s = statSync(join(root, rel)); return s.isFile() && s.size <= MAX_BYTES; } catch { return false; }
  }).sort();
  const truncated = rels.length > MAX_FILES;
  return { files: truncated ? rels.slice(0, MAX_FILES) : rels, truncated };
}
