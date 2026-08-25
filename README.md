# mcp-probe

**Conformance and robustness tests for MCP servers. Built to run in CI.**

[![CI](https://github.com/Beeeeen/mcp-probe/actions/workflows/ci.yml/badge.svg)](https://github.com/Beeeeen/mcp-probe/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/mcp-probe.svg)](https://www.npmjs.com/package/mcp-probe)
[![node](https://img.shields.io/node/v/mcp-probe.svg)](https://www.npmjs.com/package/mcp-probe)
[![license](https://img.shields.io/npm/l/mcp-probe.svg)](./LICENSE)

```bash
npx mcp-probe -- node build/index.js
```

No install, no config, no dependencies. Point it at a server, get a verdict.

---

## Why this exists

The official [Inspector](https://github.com/modelcontextprotocol/inspector) is a **visual** tool. You click through it by hand, and it tells you what a healthy server does. There is nothing that tells you what a *broken* one does, and nothing that runs on every pull request.

So these ship, constantly:

```js
console.log('Server started')   // <- stdout IS the protocol channel.
```

That one line corrupts the JSON-RPC stream. The host cannot parse it, so it disconnects — or worse, silently drops every message after it. No stack trace, no error, no log. The server "just doesn't work in Claude Desktop" and you spend an afternoon on it.

Every MCP client library discards bytes it cannot parse, which is why nothing reports this. **mcp-probe keeps the discarded bytes and shows them to you.**

That is one check out of 16, across roughly 30 distinct findings — all of them things that have shipped in real, published servers.

---

## What it finds

Run against a server with the usual set of mistakes:

```
  mcp-probe  bad-fixture
  node server.js  |  protocol 2025-06-18

  protocol conformance
    WARN  initialize returns serverInfo.version
          "bad-fixture" reports no version.
    PASS  Declared "tools" capability answers tools/list            5 tools
    FAIL  Declared "resources" capability answers resources/list
          resources/list returned no "resources" array.
    FAIL  Unknown method returns -32601
          Server answered a method that does not exist with a success result.

  tool schemas
    FAIL  Tool name is host-compatible (search files)
          "search files" contains characters hosts reject.
    FAIL  Tool names are unique (dup)
          "dup" is listed 2 times.
    FAIL  Tool has a description (mystery)
          No description.
    FAIL  required fields exist in properties (search files)
          required lists "directory", which is not in properties.
    PASS  Tool list does not dominate the context window            ~189 tokens across 5 tools

  robustness
    FAIL  Calling a tool that does not exist is rejected
          An unknown tool name returned a success result.
    FAIL  Missing required arguments are rejected (delete_everything)
          Ran with none of its 1 required argument and reported success.

  transport hygiene
    FAIL  stdout carries only JSON-RPC
          1 non-JSON line written to stdout.

  ----------------------------------------------------------------
  11 failed  |  8 warnings  |  9 passed  |  1 skipped   0.42s
```

Every failure comes with the offending payload and an explanation of what breaks:

```
  FAIL  stdout carries only JSON-RPC
        hygiene.stdout_purity  https://modelcontextprotocol.io/specification/2025-06-18/basic/transports
        1 non-JSON line written to stdout.
        stdout is the protocol channel for stdio transport. Every one of these
        lines corrupts the stream:

          > bad-server starting up...

        Fix: send all human-readable output to stderr (console.error, or a
        logger configured with stderr as its sink).
```

---

## Usage

```bash
# stdio server
npx mcp-probe -- node build/index.js
npx mcp-probe -- npx -y @modelcontextprotocol/server-filesystem /tmp

# streamable HTTP
npx mcp-probe --url http://localhost:3000/mcp

# a server you already have configured
npx mcp-probe --config ~/.claude.json --server github
```

`--config` reads both the `mcpServers` shape (Claude Desktop, Claude Code, Cursor) and the `servers` shape (VS Code), so you can probe a server without retyping how it launches.

mcp-probe's own flags come first; everything after `--` is the server's command line, untouched.

| flag | |
|---|---|
| `--strict` | treat warnings as failures |
| `--json` / `--json-out <file>` | machine-readable report |
| `--junit <file>` | JUnit XML for CI test reporting |
| `--only` / `--skip` | select checks by id or group |
| `--verbose` | expand the explanation for warnings |
| `--timeout <ms>` | per-request timeout (default 10000) |
| `--call-tools` | invoke tools — see [Safety](#safety) |

Exit codes: `0` clean · `1` findings · `2` could not run.

---

## In CI

```yaml
- uses: Beeeeen/mcp-probe@v1
  with:
    command: node build/index.js
    strict: true
```

Failures become inline annotations, and a table lands in the job summary. Outputs `failures`, `warnings` and `report` for later steps.

Or without the action:

```yaml
- run: npx mcp-probe --junit results.xml -- node build/index.js
```

---

## What gets checked

**Protocol conformance** — the handshake returns a usable `protocolVersion` and `serverInfo`; declared capabilities are actually implemented *and return the right shape*; unknown methods produce `-32601` rather than a crash or a fake success; `ping` answers; an older `protocolVersion` does not take the process down.

**Tool schemas** — names are unique and host-compatible; descriptions exist and are not `TODO`; `inputSchema` is a real JSON Schema rooted at `type: object`; `required` never names a field that is missing from `properties`; parameters carry descriptions; and the whole tool list is measured in tokens, because it is re-sent on *every* request and nothing else tells you what that costs.

**Robustness** — unknown tool names are rejected; omitting required arguments does not silently execute the tool anyway; wrongly typed arguments are not coerced into a wrong answer; malformed JSON-RPC on the wire does not wedge or kill the read loop; tool results are not large enough to evict the conversation.

**Transport hygiene** — stdout carries only JSON-RPC; stderr has no unhandled exceptions; the process is still alive at the end.

Every check has a stable dotted id (`schema.input_schema.orphan_required`), so `--skip` and `--only` work at any granularity, and a finding you have decided to live with can be silenced precisely.

---

## Safety

**mcp-probe does not invoke your tools unless you ask it to.**

The default run only ever calls tools with *invalid* arguments — missing required fields, wrong types. A correct server rejects those at validation, before any side effect, and that rejection is exactly what is being measured. A server that performs work anyway is the bug being reported.

To measure real responses, opt in explicitly:

```bash
npx mcp-probe --safe-tool list_directory -- node server.js   # just this one
npx mcp-probe --call-tools -- node server.js                 # all of them
```

There is a `delete_everything` tool in the test fixtures for a reason.

---

## Programmatic use

```ts
import { run, exitCodeFor } from 'mcp-probe'

const report = await run(
  { kind: 'stdio', command: 'node', args: ['build/index.js'] },
  { strict: true },
)

for (const r of report.results.filter((r) => r.status === 'fail')) {
  console.error(`${r.id}: ${r.message}`)
}
process.exit(exitCodeFor(report, true))
```

The check list is exported too, so you can run a subset or add your own:

```ts
import { allChecks, selectChecks } from 'mcp-probe'
```

---

## Design notes

**No runtime dependencies, and no MCP SDK.** The JSON-RPC layer is hand-rolled on purpose. Client libraries normalise responses and throw away what they cannot parse — which is precisely the evidence a conformance tester needs. mcp-probe reads the raw bytes so it can report what the SDK would have hidden.

**A broken server is a result, not an exception.** A server that will not start, will not handshake, or dies mid-run produces a report saying so. CI can always render something.

**Findings explain themselves.** Each one carries the payload that triggered it, a link to the relevant part of the spec, and a sentence on what actually breaks. A finding you cannot act on is noise.

---

## Contributing

New checks are welcome, especially ones drawn from a bug you actually hit. A check is one object in `src/checks/`, and the bar is:

- it must be **actionable** — the message says what to change
- it must not **false-positive** on the reference servers (`@modelcontextprotocol/server-everything` and `server-filesystem` are probed in CI)
- add the defect to `test/fixtures/bad-server.js` and assert on it in `test/probe.test.js`

```bash
npm install && npm run build && npm test
```

## License

MIT
