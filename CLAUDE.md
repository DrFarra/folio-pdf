## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

Rules:
- For codebase questions, first run `graphify query "<question>"` when graphify-out/graph.json exists. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).

## Using the graph in Folio

- The graph is orientation, not ground truth: before changing code, read the files and lines involved. Edges marked INFERRED, and anything in Kotlin (partially parsed), may be incomplete.
- To weigh a change, run `graphify affected "<symbol>"` to list what depends on it, then confirm each caller in the source.
- It covers Folio's own code (TypeScript, Rust, Swift, Kotlin and the test scripts). `.graphifyignore` leaves out vendored PDF.js/OCR in `public/`, Tauri's generated Android project, icons, docs and lockfiles.
