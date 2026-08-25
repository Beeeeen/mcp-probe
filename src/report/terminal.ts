import type { CheckResult, RunReport, Status } from '../types.js'

const useColor =
  !process.env['NO_COLOR'] && (process.env['FORCE_COLOR'] === '1' || process.stdout.isTTY === true)

const c = {
  reset: useColor ? '\x1b[0m' : '',
  dim: useColor ? '\x1b[2m' : '',
  bold: useColor ? '\x1b[1m' : '',
  red: useColor ? '\x1b[31m' : '',
  green: useColor ? '\x1b[32m' : '',
  yellow: useColor ? '\x1b[33m' : '',
  blue: useColor ? '\x1b[34m' : '',
  gray: useColor ? '\x1b[90m' : '',
}

const MARK: Record<Status, string> = {
  pass: `${c.green}PASS${c.reset}`,
  fail: `${c.red}FAIL${c.reset}`,
  warn: `${c.yellow}WARN${c.reset}`,
  skip: `${c.gray}SKIP${c.reset}`,
}

/** Visible width, so ANSI codes do not throw the column maths off. */
function width(s: string): number {
  return s.replace(/\x1b\[[0-9;]*m/g, '').length
}

function pad(s: string, to: number): string {
  const w = width(s)
  return w >= to ? s : s + ' '.repeat(to - w)
}

function groupOf(id: string): string {
  return id.split('.')[0] ?? id
}

const GROUP_TITLES: Record<string, string> = {
  connect: 'connection',
  protocol: 'protocol conformance',
  schema: 'tool schemas',
  robustness: 'robustness',
  hygiene: 'transport hygiene',
}

export interface TerminalOptions {
  /** Show the detail block for warnings too, not just failures. */
  verbose?: boolean
}

export function renderTerminal(report: RunReport, opts: TerminalOptions = {}): string {
  const lines: string[] = []
  const { server, results, summary } = report

  const title = server.name ? `${server.name}${server.version ? ` v${server.version}` : ''}` : server.target
  lines.push('')
  lines.push(`  ${c.bold}mcp-probe${c.reset}  ${title}`)
  lines.push(
    `  ${c.gray}${server.target}${server.protocolVersion ? `  ${c.dim}|${c.reset}${c.gray}  protocol ${server.protocolVersion}` : ''}${c.reset}`,
  )
  lines.push('')

  const groups = new Map<string, CheckResult[]>()
  for (const r of results) {
    const g = groupOf(r.id)
    if (!groups.has(g)) groups.set(g, [])
    groups.get(g)!.push(r)
  }

  for (const [group, items] of groups) {
    lines.push(`  ${c.bold}${GROUP_TITLES[group] ?? group}${c.reset}`)
    for (const r of items) {
      const label = r.target ? `${r.title} ${c.gray}(${r.target})${c.reset}` : r.title
      const timing = r.ms !== undefined ? `${c.gray}${r.ms}ms${c.reset}` : ''
      // Some checks report their timing as the message; do not print it twice.
      const showNote = r.status === 'pass' && r.message && r.message !== `${r.ms}ms`
      const note = showNote ? `${c.gray}${r.message}${c.reset}` : ''
      const right = [note, timing].filter(Boolean).join('  ')
      lines.push(`    ${MARK[r.status]}  ${pad(label, 58)}${right}`)
      if (r.status !== 'pass' && r.message) {
        lines.push(`          ${c.gray}${r.message}${c.reset}`)
      }
    }
    lines.push('')
  }

  // Failures always get a detail block. Warnings stay collapsed unless asked
  // for, so a run with many small nits does not bury the things that broke.
  const hiddenWarnings = opts.verbose ? 0 : results.filter((r) => r.status === 'warn' && r.detail).length
  const withDetail = results.filter((r) => r.detail && (r.status === 'fail' || (opts.verbose && r.status === 'warn')))

  if (withDetail.length > 0) {
    lines.push(`  ${c.bold}details${c.reset}`)
    lines.push('')
    for (const r of withDetail) {
      const colour = r.status === 'fail' ? c.red : c.yellow
      lines.push(`  ${colour}${r.status === 'fail' ? 'FAIL' : 'WARN'}${c.reset}  ${c.bold}${r.title}${r.target ? ` ${c.reset}${c.gray}(${r.target})` : ''}${c.reset}`)
      lines.push(`        ${c.gray}${r.id}${r.spec ? `  ${r.spec}` : ''}${c.reset}`)
      if (r.message) lines.push(`        ${r.message}`)
      for (const dl of (r.detail ?? '').split('\n')) lines.push(`        ${c.gray}${dl}${c.reset}`)
      lines.push('')
    }
  }

  const parts: string[] = []
  if (summary.fail) parts.push(`${c.red}${summary.fail} failed${c.reset}`)
  if (summary.warn) parts.push(`${c.yellow}${summary.warn} warning${summary.warn === 1 ? '' : 's'}${c.reset}`)
  if (summary.pass) parts.push(`${c.green}${summary.pass} passed${c.reset}`)
  if (summary.skip) parts.push(`${c.gray}${summary.skip} skipped${c.reset}`)

  lines.push(`  ${c.gray}${'-'.repeat(64)}${c.reset}`)
  lines.push(`  ${parts.join(`${c.gray}  |  ${c.reset}`)}   ${c.gray}${(report.durationMs / 1000).toFixed(2)}s${c.reset}`)
  if (hiddenWarnings > 0) {
    lines.push(`  ${c.gray}${hiddenWarnings} warning${hiddenWarnings === 1 ? '' : 's'} not expanded. Run with --verbose for the full explanation.${c.reset}`)
  }
  lines.push('')
  return lines.join('\n')
}
