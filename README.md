# ts-mcp-server

[![CI](https://github.com/yakim-nick/ts-mcp-server/actions/workflows/ci.yml/badge.svg)](https://github.com/yakim-nick/ts-mcp-server/actions/workflows/ci.yml)

A small **read-only [MCP](https://modelcontextprotocol.io) server** in TypeScript. It lets an AI
assistant (or any MCP client) look around **one project directory**: see the file tree, read
text files and read the recent git history. Nothing outside that directory is opened, and nothing
can be written or executed through it.

Built on the official [`@modelcontextprotocol/sdk`](https://www.npmjs.com/package/@modelcontextprotocol/sdk)
(1.32) with Zod schemas and the stdio transport. It is a learning project and a template for small
tool servers. A Rust version of the same server lives in
[rust-mcp-server](https://github.com/yakim-nick/rust-mcp-server).

## Tools

All three are annotated `readOnlyHint: true`, `destructiveHint: false`, `openWorldHint: false`.

| Tool         | Arguments                                          | What it does                                                                         |
| ------------ | -------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `list_files` | `path?`, `max_depth?` (1-5, default 2)             | Indented tree, directories first. Stops at 500 entries and says so.                  |
| `read_file`  | `path`, `max_bytes?` (default 64 KiB, max 256 KiB) | UTF-8 text; longer files are truncated and marked. Binary files are refused.         |
| `git_log`    | `limit?` (1-50, default 10)                        | `hash  date  author  subject`, newest first. A clear error outside a git repository. |

Failures (bad path, missing argument, not a repo) come back as **tool errors**
(`isError: true` with a readable message) so a model can correct its own call.

## Install and connect

Needs Node 22.12+ and `git` on the `PATH` (for `git_log`).

```bash
git clone https://github.com/yakim-nick/ts-mcp-server && cd ts-mcp-server
npm install && npm run build
node dist/main.js /path/to/project          # or: npm run dev -- /path/to/project
```

The server speaks MCP on stdin/stdout, so a client normally starts it. For clients that use the
common `mcpServers` JSON config:

```json
{
  "mcpServers": {
    "project": {
      "command": "node",
      "args": ["/absolute/path/to/ts-mcp-server/dist/main.js", "/absolute/path/to/project"]
    }
  }
}
```

For Claude Code the equivalent is
`claude mcp add project -- node /absolute/path/to/ts-mcp-server/dist/main.js /absolute/path/to/project`.
I have **not** tested it inside Claude Code or another desktop client (see
[What is verified](#what-is-verified-and-what-is-not)).

## Security model

- **Confinement.** Every path is resolved in `src/sandbox.ts`: relative only, no `..`, symlinks
  resolved, and the result must still be inside the project root. A symlink pointing outside
  cannot be followed. Listings skip symlinks.
- **Deny list.** `.git` and files named `.env` or `.env.*` are never listed or readable, also
  not through a symlink inside the project.
- **Limits.** Reads capped at 256 KiB, listings at 500 entries and depth 5, `git` at 10 seconds.
- **No shell.** `git_log` runs `git` through `execFile` with fixed arguments; only a validated
  number comes from the request.
- **Read-only.** No tool writes, deletes or runs anything.
- **Errors do not leak paths.** Tool errors never contain the absolute project path (tested).

Not protected:

- The deny list is small on purpose. A secret in another file (`id_rsa`, `credentials.json`) **is
  readable** if it is inside the project. Point the server at a directory with nothing you would
  not show the model.
- `git_log` runs the real `git` against that directory and git honours the repository's own
  configuration. I have not audited which settings could make `git log` run other programs, so
  only use repositories you trust.
- Whatever a tool returns is sent to the model the client is connected to.

## Layout

```
src/main.ts      argument handling and the stdio transport (diagnostics on stderr only)
src/server.ts    tool registration with Zod schemas and annotations
src/tools.ts     list_files, read_file, git_log as plain functions
src/sandbox.ts   the security boundary
tests/           sandbox unit tests; end-to-end tests over the real protocol
```

## Tests

```bash
npm test                   # 22 tests
npm run typecheck && npm run lint && npm run format:check
```

The end-to-end tests connect the SDK's own client to the server through an in-memory transport
pair, so initialisation, tool listing, schemas, annotations and calls are real MCP traffic. Two more
tests run `src/main.ts` as a child process over stdio and check that **stdout carries only
JSON-RPC** and that a bad directory exits with status 2. Coverage is 94.9% of statements
(`npm run test:coverage`, with a floor in the config). CI runs on Linux.

## What is verified, and what is not

**Verified:** everything above, on Node 22: path confinement (traversal, absolute paths, denied
names, symlink escapes, a symlink to a denied file), truncation that never splits a character,
the entry limit, git history ordering and limits, error shapes, and the stdio transport.

**Not verified:** the official MCP Inspector and real desktop clients (Claude Code, Claude
Desktop...), Windows and macOS, and behaviour under very large repositories. Nothing here
claims performance numbers.

## Known limitations

- Reads whole files up to the cap; no search, no glob filtering, no `.gitignore` handling.
- `git_log` only; no diff or blame.
- stdio only (no HTTP transport) and one project directory per server process.

## Roadmap

- `search_text` (bounded grep) and `.gitignore`-aware listings.
- A configurable deny list.
- Compare behaviour with the Rust implementation.

## License

MIT
