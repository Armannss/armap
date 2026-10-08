---
name: armap
description: Use the repo map before exploring an unfamiliar codebase, tracing how files depend on each other, or finding where a symbol is defined or used. Saves tokens by replacing broad searches and whole-file reads with targeted ones.
---

# Armap

A "Repo map" block is added to the context at session start. It lists the files other code depends on most, with the line of each key definition, and ends with a `Query before reading files:` line that gives the exact command to run.

Work from the map instead of exploring blind:

1. Pick candidate files from the map before running any broad search or directory listing.
2. To see how a file connects to the rest of the code, run the query command with `deps <file>`. It lists the files it uses and the files that use it, with the shared symbol names.
3. To find a symbol, run the query command with `refs <symbol>`. It gives the defining file and line, and every file that references it.
4. When you open a file, read only the region around the `L<n>` line you need rather than the whole file.
5. If the map does not cover the area you need, rerun it with `map --budget 4000` for a longer listing.

Links come from resolved import statements in JavaScript, TypeScript, Python, Go, Rust, Java, Kotlin, C, C++, C#, Ruby, PHP, Dart and Elixir, so a `deps` or `refs` answer for those can be used as is: do not repeat it with a search. In other languages links are inferred from shared names and are a hint to confirm with one targeted read. Dynamic imports built from variables, and symbols reached only through reflection or dependency injection, are not seen.
