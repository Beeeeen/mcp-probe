import type { CheckResult, Severity, Status } from '../types.js'

export function result(
  id: string,
  title: string,
  status: Status,
  severity: Severity,
  extra: Partial<CheckResult> = {},
): CheckResult {
  return { id, title, status, severity, ...extra }
}

/** Trim a payload for display without hiding the part that matters. */
export function preview(value: unknown, max = 300): string {
  let s: string
  try {
    s = typeof value === 'string' ? value : JSON.stringify(value)
  } catch {
    s = String(value)
  }
  if (s === undefined) return 'undefined'
  return s.length > max ? s.slice(0, max) + ` ... (+${s.length - max} chars)` : s
}

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Rough token estimate. Good enough to flag payloads that will blow context. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}
