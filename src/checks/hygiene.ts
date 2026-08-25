import type { Check, CheckContext, CheckResult } from '../types.js'
import { result } from './util.js'

const SPEC = 'https://modelcontextprotocol.io/specification/2025-06-18/basic/transports'

/** Frameworks and runtimes that print to stdout unless told otherwise. */
const KNOWN_NOISE_SOURCES: Array<[RegExp, string]> = [
  [/^\s*(Debugger attached|Waiting for the debugger)/i, 'Node.js inspector output. Drop --inspect from the launch command.'],
  [/npm (warn|notice|WARN)/i, 'npm chatter. Run the built entrypoint directly instead of through `npm run`, or pass --silent.'],
  [/^\s*>\s/, 'An npm lifecycle script echo. `npm run` prints the command it is about to run onto stdout.'],
  [/(DeprecationWarning|ExperimentalWarning|MaxListenersExceeded)/i, 'A Node warning. Route warnings to stderr with NODE_OPTIONS=--no-warnings or process.removeAllListeners("warning").'],
  [/^\s*(INFO|DEBUG|WARN|ERROR|TRACE)[\s:\]]/i, 'A logger writing to stdout. Point the logger at stderr.'],
  [/^\s*\{\s*$|^\s*\}\s*$/, 'Pretty-printed JSON. The stdio framing is one JSON object per line -- multi-line output desynchronises the stream.'],
  [/Server (running|started|listening)/i, 'A startup banner. Print it to stderr, or not at all.'],
]

function explain(line: string): string | null {
  for (const [pattern, hint] of KNOWN_NOISE_SOURCES) if (pattern.test(line)) return hint
  return null
}

/**
 * The single most common way to break an stdio MCP server, and the hardest to
 * diagnose: one `console.log` anywhere in the process -- yours, a dependency's,
 * or the runtime's -- puts a non-JSON line on stdout. stdout *is* the protocol
 * channel, so the host's parser desynchronises and the server appears to hang
 * or disconnect at random, with no error anywhere.
 *
 * Nothing else in the toolchain reports this, because every client library
 * discards what it cannot parse. We keep the discarded lines instead.
 */
export const stdoutPurityCheck: Check = {
  id: 'hygiene.stdout_purity',
  title: 'stdout carries only JSON-RPC',
  severity: 'error',
  spec: SPEC,
  run(ctx: CheckContext): CheckResult[] {
    const t = ctx.client.transport
    if (t.kind !== 'stdio') {
      return [result('hygiene.stdout_purity', 'stdout carries only JSON-RPC', 'skip', 'error', { message: 'stdio only.' })]
    }

    const noise = t.stdoutNoise
    if (noise.length === 0) {
      return [
        result('hygiene.stdout_purity', 'stdout carries only JSON-RPC', 'pass', 'error', {
          message: 'No non-JSON output on stdout.',
        }),
      ]
    }

    const shown = noise.slice(0, 8)
    const hints = new Set<string>()
    for (const line of noise) {
      const hint = explain(line)
      if (hint) hints.add(hint)
    }

    const lines = shown.map((l) => `  > ${l.length > 160 ? l.slice(0, 160) + ' ...' : l}`).join('\n')
    const more = noise.length > shown.length ? `\n  ... and ${noise.length - shown.length} more line(s)` : ''
    const diagnosis = hints.size > 0 ? `\n\nLikely cause:\n${[...hints].map((h) => `  - ${h}`).join('\n')}` : ''

    return [
      result('hygiene.stdout_purity', 'stdout carries only JSON-RPC', 'fail', 'error', {
        message: `${noise.length} non-JSON line${noise.length === 1 ? '' : 's'} written to stdout.`,
        detail: `stdout is the protocol channel for stdio transport. Every one of these lines corrupts the stream:\n\n${lines}${more}${diagnosis}\n\nFix: send all human-readable output to stderr (console.error, or a logger configured with stderr as its sink).`,
        spec: SPEC,
      }),
    ]
  },
}

/** A server that dies during the run fails everything after it; say so plainly. */
export const survivalCheck: Check = {
  id: 'hygiene.survival',
  title: 'Server is still running at the end of the suite',
  severity: 'error',
  run(ctx: CheckContext): CheckResult[] {
    const t = ctx.client.transport
    if (t.isAlive()) {
      return [result('hygiene.survival', 'Server is still running at the end of the suite', 'pass', 'error')]
    }
    const info = t.exitInfo()
    return [
      result('hygiene.survival', 'Server is still running at the end of the suite', 'fail', 'error', {
        message: `Server exited during the run (code ${info?.code ?? 'null'}${info?.signal ? `, signal ${info.signal}` : ''}).`,
        detail: `Last stderr:\n${t.stderr.slice(-12).join('\n') || '(none)'}`,
      }),
    ]
  },
}

/** Stack traces on stderr are legal but almost always mean an unhandled path. */
export const stderrSanityCheck: Check = {
  id: 'hygiene.stderr',
  title: 'No unhandled exceptions on stderr',
  severity: 'warn',
  run(ctx: CheckContext): CheckResult[] {
    const t = ctx.client.transport
    const suspicious = t.stderr.filter((l) =>
      /(UnhandledPromiseRejection|Unhandled 'error' event|^\s*at \S+ \(|Traceback \(most recent call last\)|panic:)/.test(l),
    )
    if (suspicious.length === 0) {
      return [result('hygiene.stderr', 'No unhandled exceptions on stderr', 'pass', 'warn')]
    }
    return [
      result('hygiene.stderr', 'No unhandled exceptions on stderr', 'warn', 'warn', {
        message: `${suspicious.length} line${suspicious.length === 1 ? '' : 's'} on stderr look like an unhandled exception.`,
        detail: suspicious.slice(0, 12).join('\n'),
      }),
    ]
  },
}

export const hygieneChecks: Check[] = [stdoutPurityCheck, stderrSanityCheck, survivalCheck]
