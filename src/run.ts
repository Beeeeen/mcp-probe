import { McpClient, StdioTransport, HttpTransport, type Transport } from './client/index.js'
import { allChecks, selectChecks } from './checks/index.js'
import { result } from './checks/util.js'
import type { CheckContext, CheckResult, RunOptions, RunReport, ToolDef } from './types.js'

export interface TargetSpec {
  kind: 'stdio' | 'http'
  /** stdio */
  command?: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
  /** http */
  url?: string
  headers?: Record<string, string>
}

export const DEFAULT_OPTIONS: RunOptions = {
  timeoutMs: 10_000,
  callTools: false,
  safeTools: [],
  strict: false,
}

function buildTransport(target: TargetSpec): Transport {
  if (target.kind === 'http') {
    if (!target.url) throw new Error('An http target needs a url')
    return new HttpTransport({ url: target.url, headers: target.headers })
  }
  if (!target.command) throw new Error('A stdio target needs a command')
  return new StdioTransport({
    command: target.command,
    args: target.args ?? [],
    env: target.env,
    cwd: target.cwd,
  })
}

function summarise(results: CheckResult[]): RunReport['summary'] {
  const summary = { pass: 0, fail: 0, warn: 0, skip: 0 }
  for (const r of results) summary[r.status]++
  return summary
}

/**
 * Run the suite against one server and return everything that happened.
 * Never throws for a server-side fault -- a server that cannot even handshake
 * is a *result*, not an exception, or CI could not report on it.
 */
export async function run(
  target: TargetSpec,
  options: Partial<RunOptions> = {},
  hooks: { onResult?: (r: CheckResult) => void } = {},
): Promise<RunReport> {
  const opts: RunOptions = { ...DEFAULT_OPTIONS, ...options }
  const started = Date.now()
  const transport = buildTransport(target)
  const client = new McpClient(transport, opts.timeoutMs)
  const results: CheckResult[] = []

  // Two tools that share a name produce results indistinguishable to the
  // reader, so collapse exact repeats rather than printing the same line twice.
  const seenResults = new Set<string>()
  const emit = (r: CheckResult) => {
    const key = `${r.id}|${r.target ?? ''}|${r.message ?? ''}`
    if (seenResults.has(key)) return
    seenResults.add(key)
    results.push(r)
    hooks.onResult?.(r)
  }

  const finish = (): RunReport => ({
    server: {
      name: ctx?.serverInfo?.name,
      version: ctx?.serverInfo?.version,
      protocolVersion: ctx?.protocolVersion ?? null,
      target: transport.target,
    },
    results,
    summary: summarise(results),
    durationMs: Date.now() - started,
    stdoutNoise: [...transport.stdoutNoise],
    stderr: [...transport.stderr],
  })

  let ctx: CheckContext | null = null

  try {
    await client.start()
  } catch (e) {
    emit(
      result('connect', 'Server starts', 'fail', 'error', {
        message: (e as Error).message,
        detail: transport.stderr.slice(-12).join('\n') || undefined,
      }),
    )
    return finish()
  }

  // The handshake gates everything: without it there is nothing to check.
  let handshake
  try {
    handshake = await client.initialize()
  } catch (e) {
    emit(
      result('connect', 'Server completes the initialize handshake', 'fail', 'error', {
        message: (e as Error).message,
        detail: [
          transport.stdoutNoise.length > 0
            ? `Non-JSON output appeared on stdout before any reply:\n${transport.stdoutNoise.slice(0, 5).map((l) => `  > ${l}`).join('\n')}\n\nThis alone will prevent every client from connecting.`
            : '',
          transport.stderr.slice(-12).join('\n'),
        ]
          .filter(Boolean)
          .join('\n\n') || undefined,
      }),
    )
    await client.close()
    return finish()
  }

  if (handshake.raw.error) {
    emit(
      result('connect', 'Server completes the initialize handshake', 'fail', 'error', {
        message: `initialize returned error ${handshake.raw.error.code}: ${handshake.raw.error.message}`,
        ms: handshake.ms,
      }),
    )
    await client.close()
    return finish()
  }

  emit(result('connect', 'Server completes the initialize handshake', 'pass', 'error', { ms: handshake.ms }))
  client.notifyInitialized()

  // Gather once so individual checks do not each re-list.
  let tools: ToolDef[] = []
  const { tools: listed, error: listError } = await client.listTools().catch(() => ({ tools: [], error: undefined }))
  if (listError) {
    emit(
      result('connect.tools_list', 'tools/list responds', 'fail', 'error', {
        message: `tools/list returned error ${listError.error?.code}: ${listError.error?.message}`,
      }),
    )
  } else {
    tools = listed
  }

  const resources = await client.listAll('resources/list', 'resources').then((r) => r.items).catch(() => [])
  const prompts = await client.listAll('prompts/list', 'prompts').then((r) => r.items).catch(() => [])

  ctx = {
    client,
    tools,
    resources,
    prompts,
    serverInfo: handshake.serverInfo,
    capabilities: handshake.capabilities,
    protocolVersion: handshake.protocolVersion,
    options: opts,
  }

  for (const check of selectChecks(allChecks, opts.only, opts.skip)) {
    try {
      for (const r of await check.run(ctx)) emit(r)
    } catch (e) {
      // A check that throws is a bug in mcp-probe, not in the server under
      // test. Say which one, and keep going -- one broken check must not
      // invalidate the rest of the report.
      emit(
        result(check.id, check.title, 'skip', 'info', {
          message: `Check errored internally: ${(e as Error).message}`,
          detail: 'This is a bug in mcp-probe. Please report it with the server that triggered it.',
        }),
      )
    }
  }

  await client.close()
  return finish()
}

/** Exit code contract: 0 clean, 1 findings, 2 could not run. */
export function exitCodeFor(report: RunReport, strict: boolean): number {
  if (report.summary.fail > 0) return 1
  if (strict && report.summary.warn > 0) return 1
  return 0
}
