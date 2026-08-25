#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs'
import { run, exitCodeFor, type TargetSpec } from './run.js'
import { renderTerminal } from './report/terminal.js'
import { renderJUnit } from './report/junit.js'
import type { RunOptions } from './types.js'

const VERSION = '0.1.0'

const HELP = `
  mcp-probe ${VERSION}
  Conformance and robustness tests for MCP servers. Built for CI.

  USAGE
    mcp-probe <command> [args...]        run a stdio server and probe it
    mcp-probe --url <url>               probe a streamable-HTTP server
    mcp-probe --config <file> --server <name>

  EXAMPLES
    mcp-probe node build/index.js
    mcp-probe -- npx -y @modelcontextprotocol/server-filesystem /tmp
    mcp-probe --url http://localhost:3000/mcp
    mcp-probe --config ~/.claude.json --server github
    mcp-probe --junit results.xml --strict -- node server.js

  OUTPUT
    --json                  machine-readable report on stdout
    --json-out <file>       write the JSON report to a file, keeping the
                            human-readable report on stdout
    --junit <file>          write JUnit XML (GitHub, GitLab, Jenkins, ...)
    --quiet                 suppress the terminal report
    --verbose               expand the explanation for warnings too

  SELECTION
    --only <id>             run only these checks; repeatable, prefix match
    --skip <id>             skip these checks; repeatable, prefix match
                            groups: protocol, schema, robustness, hygiene

  BEHAVIOUR
    --timeout <ms>          per-request timeout (default 10000)
    --strict                treat warnings as failures for the exit code
    --call-tools            invoke every tool with empty arguments.
                            OFF by default: mcp-probe never triggers a side
                            effect you did not ask for.
    --safe-tool <name>      invoke just this tool; repeatable
    --header <k:v>          extra HTTP header; repeatable (http only)
    --env <k=v>             extra environment variable; repeatable (stdio only)

  EXIT CODES
    0  no failures
    1  at least one failure (or a warning under --strict)
    2  could not run at all

  mcp-probe's own flags come first. Everything from the first non-flag argument
  (or from a bare "--") onward is the server's command line, passed through
  untouched, so a server flag can never collide with one of ours. Use "--"
  whenever the command itself starts with a dash.
`

interface Parsed {
  target: TargetSpec | null
  options: Partial<RunOptions>
  json: boolean
  jsonOut: string | null
  junit: string | null
  quiet: boolean
  verbose: boolean
  help: boolean
  version: boolean
  error?: string
}

function parseArgs(argv: string[]): Parsed {
  const out: Parsed = {
    target: null,
    options: {},
    json: false,
    jsonOut: null,
    junit: null,
    quiet: false,
    verbose: false,
    help: false,
    version: false,
  }
  const only: string[] = []
  const skip: string[] = []
  const safeTools: string[] = []
  const headers: Record<string, string> = {}
  const env: Record<string, string> = {}
  let url: string | null = null
  let configPath: string | null = null
  let serverName: string | null = null
  let command: string | null = null
  let commandArgs: string[] = []

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    // Once a command is known, the rest belongs to the server, untouched.
    if (command !== null) {
      commandArgs.push(arg)
      continue
    }
    // `--` ends our own flags: the next token is the command, whatever it
    // looks like. Needed when the command itself begins with a dash.
    if (arg === '--') {
      const rest = argv.slice(i + 1)
      if (rest.length === 0) return { ...out, error: '`--` must be followed by the server command' }
      command = rest[0]!
      commandArgs = rest.slice(1)
      break
    }
    const next = () => argv[++i]

    switch (arg) {
      case '-h':
      case '--help':
        out.help = true
        break
      case '-v':
      case '--version':
        out.version = true
        break
      case '--json':
        out.json = true
        break
      case '--quiet':
        out.quiet = true
        break
      case '--verbose':
        out.verbose = true
        break
      case '--strict':
        out.options.strict = true
        break
      case '--call-tools':
        out.options.callTools = true
        break
      case '--junit':
        out.junit = next() ?? null
        break
      case '--json-out':
        out.jsonOut = next() ?? null
        break
      case '--url':
        url = next() ?? null
        break
      case '--config':
        configPath = next() ?? null
        break
      case '--server':
        serverName = next() ?? null
        break
      case '--timeout': {
        const v = Number(next())
        if (!Number.isFinite(v) || v <= 0) return { ...out, error: '--timeout needs a positive number of milliseconds' }
        out.options.timeoutMs = v
        break
      }
      case '--only':
        only.push(...(next() ?? '').split(',').filter(Boolean))
        break
      case '--skip':
        skip.push(...(next() ?? '').split(',').filter(Boolean))
        break
      case '--safe-tool':
        safeTools.push(...(next() ?? '').split(',').filter(Boolean))
        break
      case '--header': {
        const raw = next() ?? ''
        const idx = raw.indexOf(':')
        if (idx < 1) return { ...out, error: `--header expects "Name: value", got "${raw}"` }
        headers[raw.slice(0, idx).trim()] = raw.slice(idx + 1).trim()
        break
      }
      case '--env': {
        const raw = next() ?? ''
        const idx = raw.indexOf('=')
        if (idx < 1) return { ...out, error: `--env expects "KEY=value", got "${raw}"` }
        env[raw.slice(0, idx)] = raw.slice(idx + 1)
        break
      }
      default:
        if (arg.startsWith('-')) return { ...out, error: `Unknown option "${arg}". Try --help.` }
        command = arg
    }
  }

  if (only.length) out.options.only = only
  if (skip.length) out.options.skip = skip
  if (safeTools.length) out.options.safeTools = safeTools

  if (configPath) {
    const resolved = resolveFromConfig(configPath, serverName)
    if ('error' in resolved) return { ...out, error: resolved.error }
    out.target = resolved.target
    if (Object.keys(env).length) out.target.env = { ...out.target.env, ...env }
    return out
  }
  if (url) {
    out.target = { kind: 'http', url, headers }
    return out
  }
  if (command) {
    out.target = { kind: 'stdio', command, args: commandArgs, env }
    return out
  }
  return out
}

/**
 * Read a server definition out of an existing MCP config file, so a user can
 * point mcp-probe at a server they already run without retyping its command.
 * Handles both the `mcpServers` shape (Claude Desktop, Cursor) and the
 * `servers` shape (VS Code).
 */
function resolveFromConfig(path: string, name: string | null): { target: TargetSpec } | { error: string } {
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
  } catch (e) {
    return { error: `Could not read ${path}: ${(e as Error).message}` }
  }

  const block = (parsed['mcpServers'] ?? parsed['servers']) as Record<string, Record<string, unknown>> | undefined
  if (!block || typeof block !== 'object') {
    return { error: `${path} has no "mcpServers" or "servers" object.` }
  }
  const names = Object.keys(block)
  if (names.length === 0) return { error: `${path} defines no servers.` }

  const chosen = name ?? (names.length === 1 ? names[0]! : null)
  if (!chosen) {
    return { error: `${path} defines ${names.length} servers. Pick one with --server <name>: ${names.join(', ')}` }
  }
  const entry = block[chosen]
  if (!entry) return { error: `No server named "${chosen}" in ${path}. Available: ${names.join(', ')}` }

  if (typeof entry['url'] === 'string') {
    return { target: { kind: 'http', url: entry['url'], headers: (entry['headers'] as Record<string, string>) ?? {} } }
  }
  if (typeof entry['command'] === 'string') {
    return {
      target: {
        kind: 'stdio',
        command: entry['command'],
        args: Array.isArray(entry['args']) ? (entry['args'] as string[]) : [],
        env: (entry['env'] as Record<string, string>) ?? {},
      },
    }
  }
  return { error: `Server "${chosen}" in ${path} has neither "command" nor "url".` }
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2))

  if (parsed.help) {
    process.stdout.write(HELP)
    process.exit(0)
  }
  if (parsed.version) {
    process.stdout.write(VERSION + '\n')
    process.exit(0)
  }
  if (parsed.error) {
    process.stderr.write(`mcp-probe: ${parsed.error}\n`)
    process.exit(2)
  }
  if (!parsed.target) {
    process.stderr.write(HELP)
    process.exit(2)
  }

  const report = await run(parsed.target, parsed.options)

  if (parsed.junit) {
    try {
      writeFileSync(parsed.junit, renderJUnit(report), 'utf8')
    } catch (e) {
      process.stderr.write(`mcp-probe: could not write ${parsed.junit}: ${(e as Error).message}\n`)
    }
  }
  if (parsed.jsonOut) {
    try {
      writeFileSync(parsed.jsonOut, JSON.stringify(report, null, 2), 'utf8')
    } catch (e) {
      process.stderr.write(`mcp-probe: could not write ${parsed.jsonOut}: ${(e as Error).message}
`)
    }
  }
  if (parsed.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n')
  } else if (!parsed.quiet) {
    process.stdout.write(renderTerminal(report, { verbose: parsed.verbose }))
  }

  // Nothing ran at all: distinguish "server is broken" from "could not start".
  if (report.results.length === 1 && report.results[0]?.id === 'connect' && report.results[0].status === 'fail') {
    process.exit(2)
  }
  process.exit(exitCodeFor(report, parsed.options.strict ?? false))
}

main().catch((e: unknown) => {
  process.stderr.write(`mcp-probe: internal error: ${(e as Error).stack ?? String(e)}\n`)
  process.exit(2)
})
