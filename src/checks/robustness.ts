import type { Check, CheckContext, CheckResult, JsonSchema } from '../types.js'
import { result, preview, isPlainObject, estimateTokens } from './util.js'

const SPEC = 'https://modelcontextprotocol.io/specification/2025-06-18/server/tools'

/**
 * A tools/call that failed is reported one of two legal ways: a JSON-RPC error,
 * or a result carrying `isError: true`. Both are fine; neither is a crash.
 */
function rejectedCleanly(res: { error?: unknown; result?: unknown }): boolean {
  if (res.error) return true
  return isPlainObject(res.result) && res.result['isError'] === true
}

export const unknownToolCheck: Check = {
  id: 'robustness.unknown_tool',
  title: 'Calling a tool that does not exist is rejected',
  severity: 'error',
  spec: SPEC,
  async run(ctx: CheckContext): Promise<CheckResult[]> {
    const name = '__mcp_probe_no_such_tool__'
    try {
      const res = await ctx.client.call('tools/call', { name, arguments: {} }, Math.min(ctx.options.timeoutMs, 8000))
      if (rejectedCleanly(res)) {
        return [result('robustness.unknown_tool', 'Calling a tool that does not exist is rejected', 'pass', 'error')]
      }
      return [
        result('robustness.unknown_tool', 'Calling a tool that does not exist is rejected', 'fail', 'error', {
          message: 'An unknown tool name returned a success result.',
          detail: `Result: ${preview(res.result)}\nModels hallucinate tool names. A server that answers them feeds the hallucination back as fact.`,
          spec: SPEC,
        }),
      ]
    } catch (e) {
      return [
        result('robustness.unknown_tool', 'Calling a tool that does not exist is rejected', 'fail', 'error', {
          message: `Server stopped responding: ${(e as Error).message}`,
          detail: 'An unknown tool name must not be fatal. Models routinely invent names, and this takes the server down every time.',
          spec: SPEC,
        }),
      ]
    }
  },
}

/** Build arguments that are the wrong type for every declared property. */
function wrongTypedArgs(schema: JsonSchema | undefined): Record<string, unknown> | null {
  if (!isPlainObject(schema) || !isPlainObject(schema.properties)) return null
  const args: Record<string, unknown> = {}
  for (const [key, prop] of Object.entries(schema.properties)) {
    const t = Array.isArray((prop as JsonSchema).type) ? (prop as JsonSchema).type?.[0] : (prop as JsonSchema).type
    // Deliberately mismatched: a string where a number is wanted, and so on.
    args[key] = t === 'string' ? 12345 : t === 'number' || t === 'integer' ? 'not-a-number' : t === 'boolean' ? 'maybe' : t === 'array' ? {} : []
  }
  return Object.keys(args).length > 0 ? args : null
}

/**
 * Invalid-argument probes are safe to run unattended: a correct server rejects
 * them at validation, before any side effect. That is precisely what is being
 * measured, and it is why this runs by default while valid calls do not.
 */
export const invalidArgsCheck: Check = {
  id: 'robustness.invalid_args',
  title: 'Invalid arguments are rejected, not executed',
  severity: 'error',
  spec: SPEC,
  async run(ctx: CheckContext): Promise<CheckResult[]> {
    const out: CheckResult[] = []
    const candidates = ctx.tools.filter((t) => t?.name && isPlainObject(t.inputSchema)).slice(0, 12)

    if (candidates.length === 0) {
      return [
        result('robustness.invalid_args', 'Invalid arguments are rejected', 'skip', 'error', {
          message: 'No tools with an inputSchema to probe.',
        }),
      ]
    }

    for (const tool of candidates) {
      const name = tool.name
      const required = Array.isArray(tool.inputSchema?.required) ? tool.inputSchema!.required! : []

      // 1. Omit every required argument.
      if (required.length > 0) {
        try {
          const res = await ctx.client.call('tools/call', { name, arguments: {} }, Math.min(ctx.options.timeoutMs, 8000))
          if (!rejectedCleanly(res)) {
            out.push(
              result('robustness.invalid_args.missing_required', 'Missing required arguments are rejected', 'fail', 'error', {
                target: name,
                message: `Ran with none of its ${required.length} required argument${required.length === 1 ? '' : 's'} and reported success.`,
                detail: `Required: ${required.join(', ')}\nResult: ${preview(res.result)}\nThe tool either silently used defaults or acted on undefined -- both produce wrong answers the model will trust.`,
                spec: SPEC,
              }),
            )
          }
        } catch (e) {
          out.push(
            result('robustness.invalid_args.missing_required', 'Missing required arguments are rejected', 'fail', 'error', {
              target: name,
              message: `Server stopped responding when required arguments were omitted: ${(e as Error).message}`,
              detail: 'This is an unguarded property access on the argument object. Validate before you dereference.',
              spec: SPEC,
            }),
          )
        }
      }

      // 2. Send every argument with the wrong type.
      const bad = wrongTypedArgs(tool.inputSchema)
      if (bad) {
        try {
          const res = await ctx.client.call('tools/call', { name, arguments: bad }, Math.min(ctx.options.timeoutMs, 8000))
          if (!rejectedCleanly(res)) {
            out.push(
              result('robustness.invalid_args.wrong_types', 'Wrongly typed arguments are rejected', 'warn', 'warn', {
                target: name,
                message: 'Accepted arguments whose types contradict its own schema.',
                detail: `Sent: ${preview(bad, 200)}\nResult: ${preview(res.result, 200)}\nModels do emit the wrong type. Coercing silently turns a type error into a wrong result.`,
                spec: SPEC,
              }),
            )
          }
        } catch (e) {
          out.push(
            result('robustness.invalid_args.wrong_types', 'Wrongly typed arguments are rejected', 'fail', 'error', {
              target: name,
              message: `Server stopped responding on wrongly typed arguments: ${(e as Error).message}`,
              spec: SPEC,
            }),
          )
        }
      }
    }

    if (out.length === 0) {
      out.push(
        result('robustness.invalid_args', 'Invalid arguments are rejected, not executed', 'pass', 'error', {
          message: `${candidates.length} tool${candidates.length === 1 ? '' : 's'} rejected bad input cleanly.`,
        }),
      )
    }
    return out
  },
}

/** Garbage on the wire must not be fatal; a public server sees it constantly. */
export const malformedInputCheck: Check = {
  id: 'robustness.malformed_input',
  title: 'Survives malformed JSON-RPC',
  severity: 'error',
  spec: 'https://www.jsonrpc.org/specification#error_object',
  async run(ctx: CheckContext): Promise<CheckResult[]> {
    const t = ctx.client.transport
    if (t.kind !== 'stdio') {
      return [result('robustness.malformed_input', 'Survives malformed JSON-RPC', 'skip', 'error', { message: 'stdio only.' })]
    }

    t.writeRaw('this is not json at all\n')
    t.writeRaw('{"jsonrpc":"2.0","id":  \n')
    t.writeRaw('{"jsonrpc":"2.0","method":123,"id":"x"}\n')

    // Give the server a moment to mishandle it, then check it is still there.
    await new Promise((r) => setTimeout(r, 300))

    if (!t.isAlive()) {
      const info = t.exitInfo()
      return [
        result('robustness.malformed_input', 'Survives malformed JSON-RPC', 'fail', 'error', {
          message: `Server exited (code ${info?.code ?? 'null'}) after receiving malformed input.`,
          detail: `Last stderr:\n${t.stderr.slice(-8).join('\n') || '(none)'}\n\nA parse failure must produce a -32700 response, not terminate the process.`,
        }),
      ]
    }

    try {
      const res = await ctx.client.call('tools/list', {}, Math.min(ctx.options.timeoutMs, 5000))
      if (res.error) {
        return [
          result('robustness.malformed_input', 'Survives malformed JSON-RPC', 'warn', 'warn', {
            message: `Still running, but tools/list now errors: ${res.error.code} ${res.error.message}`,
            detail: 'The garbage left the read loop in a bad state. Usually a buffer that was never reset after a parse failure.',
          }),
        ]
      }
      return [
        result('robustness.malformed_input', 'Survives malformed JSON-RPC', 'pass', 'error', {
          message: 'Still serving requests after three malformed frames.',
        }),
      ]
    } catch (e) {
      return [
        result('robustness.malformed_input', 'Survives malformed JSON-RPC', 'fail', 'error', {
          message: `Process alive but unresponsive after malformed input: ${(e as Error).message}`,
          detail: 'The read loop is wedged -- typically a partial frame left in the buffer that every later read tries to parse again.',
        }),
      ]
    }
  },
}

/**
 * Tool results land in the context window verbatim. A tool that returns a
 * whole file or an unpaginated list can consume the entire budget in one call.
 * Only measured for tools actually invoked, so it is opt-in with the rest.
 */
export const responseSizeCheck: Check = {
  id: 'robustness.response_size',
  title: 'Tool results fit in a context window',
  severity: 'warn',
  spec: SPEC,
  async run(ctx: CheckContext): Promise<CheckResult[]> {
    const allowed = new Set(ctx.options.safeTools)
    const targets = ctx.options.callTools
      ? ctx.tools.filter((t) => t?.name)
      : ctx.tools.filter((t) => t?.name && allowed.has(t.name))

    if (targets.length === 0) {
      return [
        result('robustness.response_size', 'Tool results fit in a context window', 'skip', 'warn', {
          message: 'No tools were invoked. Pass --call-tools, or --safe-tool <name>, to measure real responses.',
        }),
      ]
    }

    const out: CheckResult[] = []
    for (const tool of targets.slice(0, 12)) {
      try {
        const res = await ctx.client.call('tools/call', { name: tool.name, arguments: {} }, ctx.options.timeoutMs)
        if (res.error) continue
        const tokens = estimateTokens(JSON.stringify(res.result ?? {}))
        if (tokens > 25_000) {
          out.push(
            result('robustness.response_size.huge', 'Tool result fits in a context window', 'fail', 'error', {
              target: tool.name,
              message: `Returned ~${tokens.toLocaleString('en-US')} tokens in a single call.`,
              detail: 'This evicts the conversation it was meant to inform. Paginate, or return a summary with a follow-up tool to drill in.',
              spec: SPEC,
            }),
          )
        } else if (tokens > 8_000) {
          out.push(
            result('robustness.response_size.large', 'Tool result fits in a context window', 'warn', 'warn', {
              target: tool.name,
              message: `Returned ~${tokens.toLocaleString('en-US')} tokens.`,
              detail: 'Large enough to crowd out earlier turns. Consider a limit/cursor argument.',
              spec: SPEC,
            }),
          )
        }
      } catch {
        // Timeouts and transport faults are already covered by other checks.
      }
    }

    if (out.length === 0) {
      out.push(
        result('robustness.response_size', 'Tool results fit in a context window', 'pass', 'warn', {
          message: `${Math.min(targets.length, 12)} tool response${targets.length === 1 ? '' : 's'} within budget.`,
        }),
      )
    }
    return out
  },
}

export const robustnessChecks: Check[] = [unknownToolCheck, invalidArgsCheck, malformedInputCheck, responseSizeCheck]
