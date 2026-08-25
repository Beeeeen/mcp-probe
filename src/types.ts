/** Outcome of a single check. */
export type Status = 'pass' | 'fail' | 'warn' | 'skip'

/**
 * How much a failure matters.
 * - `error`  the server is out of spec or will break agents; fails CI by default
 * - `warn`   legal but harmful in practice (vague descriptions, huge payloads)
 * - `info`   advisory only, never fails CI
 */
export type Severity = 'error' | 'warn' | 'info'

export interface CheckResult {
  /** Stable dotted id, e.g. `protocol.handshake`. Used for --skip / --only. */
  id: string
  title: string
  status: Status
  severity: Severity
  /** One line, shown inline in the terminal report. */
  message?: string
  /** Multi-line evidence: the offending payload, a diff, a stack. */
  detail?: string
  /** Tool/resource/prompt this result is about, when it is scoped to one. */
  target?: string
  /** Spec anchor so the user can check we are not making things up. */
  spec?: string
  /** Wall-clock duration in ms, when meaningful. */
  ms?: number
}

export interface CheckContext {
  client: import('./client/index.js').McpClient
  /** Populated after the handshake so later checks do not re-list. */
  tools: ToolDef[]
  resources: unknown[]
  prompts: unknown[]
  serverInfo: { name?: string; version?: string } | null
  capabilities: Record<string, unknown>
  protocolVersion: string | null
  options: RunOptions
}

export interface ToolDef {
  name: string
  description?: string
  inputSchema?: JsonSchema
  outputSchema?: JsonSchema
  annotations?: Record<string, unknown>
  title?: string
}

export interface JsonSchema {
  type?: string | string[]
  properties?: Record<string, JsonSchema>
  required?: string[]
  items?: JsonSchema | JsonSchema[]
  enum?: unknown[]
  const?: unknown
  description?: string
  additionalProperties?: boolean | JsonSchema
  [k: string]: unknown
}

export interface RunOptions {
  /** Per-request timeout. */
  timeoutMs: number
  /** Actually invoke tools (mutating!). Off by default. */
  callTools: boolean
  /** Tool names that are safe to invoke; implies callTools for those only. */
  safeTools: string[]
  only?: string[]
  skip?: string[]
  /** Treat warnings as failures for the exit code. */
  strict: boolean
}

export interface Check {
  id: string
  title: string
  severity: Severity
  spec?: string
  /** A check may emit several results (e.g. one per tool). */
  run(ctx: CheckContext): Promise<CheckResult[]> | CheckResult[]
}

export interface RunReport {
  server: { name?: string; version?: string; protocolVersion?: string | null; target: string }
  results: CheckResult[]
  summary: { pass: number; fail: number; warn: number; skip: number }
  durationMs: number
  /** Non-JSON bytes the server wrote to stdout. The classic stdio killer. */
  stdoutNoise: string[]
  stderr: string[]
}
