import type { Check, CheckContext, CheckResult } from '../types.js'
import { RPC } from '../client/jsonrpc.js'
import { SUPPORTED_PROTOCOL_VERSIONS } from '../client/index.js'
import { result, preview, isPlainObject } from './util.js'

const SPEC = 'https://modelcontextprotocol.io/specification/2025-06-18/basic/lifecycle'

/**
 * The handshake already happened in the runner (everything else depends on it),
 * so this check grades the response that came back rather than redoing it.
 */
export const handshakeCheck: Check = {
  id: 'protocol.handshake',
  title: 'initialize returns a well-formed result',
  severity: 'error',
  spec: SPEC,
  run(ctx: CheckContext): CheckResult[] {
    const out: CheckResult[] = []
    const { protocolVersion, serverInfo } = ctx

    if (!protocolVersion) {
      out.push(
        result('protocol.handshake.version', 'initialize returns protocolVersion', 'fail', 'error', {
          message: 'The initialize result had no `protocolVersion` field.',
          detail:
            'Clients use this to decide which features to attempt. Without it, well-behaved clients disconnect.',
          spec: SPEC,
        }),
      )
    } else if (!SUPPORTED_PROTOCOL_VERSIONS.includes(protocolVersion)) {
      out.push(
        result('protocol.handshake.version', 'initialize returns protocolVersion', 'warn', 'warn', {
          message: `Unrecognised protocol version "${protocolVersion}".`,
          detail: `Known versions: ${SUPPORTED_PROTOCOL_VERSIONS.join(', ')}. A typo here silently breaks feature negotiation.`,
          spec: SPEC,
        }),
      )
    } else {
      out.push(
        result('protocol.handshake.version', 'initialize returns protocolVersion', 'pass', 'error', {
          message: protocolVersion,
        }),
      )
    }

    if (!serverInfo || !serverInfo.name) {
      out.push(
        result('protocol.handshake.serverinfo', 'initialize returns serverInfo.name', 'fail', 'error', {
          message: 'Missing `serverInfo.name`.',
          detail:
            'Hosts show this name in their UI and use it to key per-server settings. An unnamed server is unidentifiable in logs.',
          spec: SPEC,
        }),
      )
    } else if (!serverInfo.version) {
      out.push(
        result('protocol.handshake.serverinfo', 'initialize returns serverInfo.version', 'warn', 'warn', {
          message: `"${serverInfo.name}" reports no version.`,
          detail: 'Without a version, users cannot tell which build produced a bug report.',
          spec: SPEC,
        }),
      )
    } else {
      out.push(
        result('protocol.handshake.serverinfo', 'initialize returns serverInfo', 'pass', 'error', {
          message: `${serverInfo.name} v${serverInfo.version}`,
        }),
      )
    }
    return out
  },
}

/** A server that advertises a capability it did not implement breaks clients at runtime. */
export const capabilityHonestyCheck: Check = {
  id: 'protocol.capabilities',
  title: 'Declared capabilities are actually implemented',
  severity: 'error',
  spec: SPEC,
  async run(ctx: CheckContext): Promise<CheckResult[]> {
    const out: CheckResult[] = []
    const caps = ctx.capabilities
    const pairs: Array<[string, 'tools/list' | 'resources/list' | 'prompts/list']> = [
      ['tools', 'tools/list'],
      ['resources', 'resources/list'],
      ['prompts', 'prompts/list'],
    ]

    for (const [cap, method] of pairs) {
      if (!isPlainObject(caps[cap])) continue
      const res = await ctx.client.call(method, {})
      if (res.error) {
        out.push(
          result(`protocol.capabilities.${cap}`, `Declared "${cap}" capability answers ${method}`, 'fail', 'error', {
            message: `Server declares "${cap}" but ${method} returned error ${res.error.code}: ${res.error.message}`,
            detail:
              'Clients call the listing method as soon as the capability is advertised. This fails on first contact.',
            spec: SPEC,
          }),
        )
        continue
      }
      // A response is not enough: it has to be the right shape. A catch-all
      // dispatcher answers every method with something, which looks like
      // success here but hands the client nothing it can use.
      const payload = (res.result ?? {}) as Record<string, unknown>
      if (!Array.isArray(payload[cap])) {
        out.push(
          result(`protocol.capabilities.${cap}`, `Declared "${cap}" capability answers ${method}`, 'fail', 'error', {
            message: `${method} returned no "${cap}" array.`,
            detail: `Got: ${preview(res.result)}\nServer declares the "${cap}" capability, so ${method} must return { "${cap}": [...] }. Returning something else usually means the method is unimplemented and a catch-all branch answered instead.`,
            spec: SPEC,
          }),
        )
        continue
      }
      out.push(
        result(`protocol.capabilities.${cap}`, `Declared "${cap}" capability answers ${method}`, 'pass', 'error', {
          message: `${(payload[cap] as unknown[]).length} ${cap}`,
        }),
      )
    }

    if (out.length === 0) {
      out.push(
        result('protocol.capabilities', 'Declared capabilities are implemented', 'warn', 'warn', {
          message: 'Server declared no tools, resources or prompts capability.',
          detail: 'Nothing is reachable through this server. Check that capabilities are registered before connect().',
        }),
      )
    }
    return out
  },
}

/** Unknown methods must produce -32601, not a crash and not a fake success. */
export const unknownMethodCheck: Check = {
  id: 'protocol.unknown_method',
  title: 'Unknown method returns -32601',
  severity: 'error',
  spec: 'https://www.jsonrpc.org/specification#error_object',
  async run(ctx: CheckContext): Promise<CheckResult[]> {
    const method = 'mcpProbe/definitelyNotAMethod'
    try {
      const res = await ctx.client.call(method, {}, Math.min(ctx.options.timeoutMs, 5000))
      if (res.error?.code === RPC.METHOD_NOT_FOUND) {
        return [result('protocol.unknown_method', 'Unknown method returns -32601', 'pass', 'error')]
      }
      if (res.error) {
        return [
          result('protocol.unknown_method', 'Unknown method returns -32601', 'warn', 'warn', {
            message: `Returned ${res.error.code} instead of ${RPC.METHOD_NOT_FOUND}.`,
            detail: `Full error: ${preview(res.error)}\nClients branch on -32601 to feature-detect. A different code reads as "the call failed", not "unsupported".`,
          }),
        ]
      }
      return [
        result('protocol.unknown_method', 'Unknown method returns -32601', 'fail', 'error', {
          message: 'Server answered a method that does not exist with a success result.',
          detail: `Result: ${preview(res.result)}\nThis means the dispatcher has a catch-all branch, so mistyped method names fail silently.`,
        }),
      ]
    } catch (e) {
      return [
        result('protocol.unknown_method', 'Unknown method returns -32601', 'fail', 'error', {
          message: `Server did not answer an unknown method: ${(e as Error).message}`,
          detail: 'An unrecognised method must be answered with an error, never dropped and never fatal.',
        }),
      ]
    }
  },
}

/** `ping` is cheap and hosts use it for liveness. */
export const pingCheck: Check = {
  id: 'protocol.ping',
  title: 'Responds to ping',
  severity: 'warn',
  spec: 'https://modelcontextprotocol.io/specification/2025-06-18/basic/utilities/ping',
  async run(ctx: CheckContext): Promise<CheckResult[]> {
    const t0 = Date.now()
    try {
      const res = await ctx.client.call('ping', {}, Math.min(ctx.options.timeoutMs, 5000))
      const ms = Date.now() - t0
      if (res.error) {
        return [
          result('protocol.ping', 'Responds to ping', 'warn', 'warn', {
            ms,
            message: `ping returned error ${res.error.code}: ${res.error.message}`,
            detail:
              'Some hosts ping to decide whether to restart a server. Failing this can cause spurious reconnects.',
          }),
        ]
      }
      return [result('protocol.ping', 'Responds to ping', 'pass', 'warn', { ms, message: `${ms}ms` })]
    } catch (e) {
      return [
        result('protocol.ping', 'Responds to ping', 'warn', 'warn', {
          message: `No response to ping: ${(e as Error).message}`,
        }),
      ]
    }
  },
}

/** Version negotiation: asking for an old version must not kill the server. */
export const versionNegotiationCheck: Check = {
  id: 'protocol.version_negotiation',
  title: 'Handles an older protocolVersion gracefully',
  severity: 'warn',
  spec: SPEC,
  async run(ctx: CheckContext): Promise<CheckResult[]> {
    const old = SUPPORTED_PROTOCOL_VERSIONS[SUPPORTED_PROTOCOL_VERSIONS.length - 1]!
    if (ctx.protocolVersion === old) {
      return [
        result('protocol.version_negotiation', 'Handles an older protocolVersion', 'skip', 'warn', {
          message: `Server already negotiated the oldest known version (${old}).`,
        }),
      ]
    }
    try {
      const res = await ctx.client.call(
        'initialize',
        { protocolVersion: old, capabilities: {}, clientInfo: { name: 'mcp-probe', version: '0.1.0' } },
        Math.min(ctx.options.timeoutMs, 5000),
      )
      if (res.error) {
        return [
          result('protocol.version_negotiation', 'Handles an older protocolVersion', 'warn', 'warn', {
            message: `Rejected version ${old} with error ${res.error.code}.`,
            detail:
              'Refusing outright is legal, but it locks out hosts that have not upgraded yet. Prefer replying with a version you do support.',
          }),
        ]
      }
      return [
        result('protocol.version_negotiation', 'Handles an older protocolVersion', 'pass', 'warn', {
          message: `Answered a ${old} handshake without failing.`,
        }),
      ]
    } catch (e) {
      return [
        result('protocol.version_negotiation', 'Handles an older protocolVersion', 'fail', 'error', {
          message: `Server stopped responding after an older-version handshake: ${(e as Error).message}`,
          detail:
            'A version it does not like must not take the process down; older hosts would kill the server on every launch.',
        }),
      ]
    }
  },
}

export const protocolChecks: Check[] = [
  handshakeCheck,
  capabilityHonestyCheck,
  unknownMethodCheck,
  pingCheck,
  versionNegotiationCheck,
]
