import type { RunReport } from '../types.js'

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    // Control characters are illegal in XML 1.0 and make parsers reject the
    // whole file -- and server output is exactly where they show up.
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '')
}

/**
 * JUnit XML, which every CI provider can render as a test report.
 * Warnings are emitted as passing cases carrying a `system-out` note so they
 * are visible without turning the build red.
 */
export function renderJUnit(report: RunReport): string {
  const { results, summary, server } = report
  const name = server.name ? `mcp-probe/${server.name}` : 'mcp-probe'
  const lines: string[] = []

  lines.push('<?xml version="1.0" encoding="UTF-8"?>')
  lines.push(
    `<testsuites name="${esc(name)}" tests="${results.length}" failures="${summary.fail}" skipped="${summary.skip}" time="${(report.durationMs / 1000).toFixed(3)}">`,
  )
  lines.push(
    `  <testsuite name="${esc(name)}" tests="${results.length}" failures="${summary.fail}" skipped="${summary.skip}" time="${(report.durationMs / 1000).toFixed(3)}">`,
  )
  lines.push(`    <properties>`)
  lines.push(`      <property name="target" value="${esc(server.target)}"/>`)
  if (server.protocolVersion) lines.push(`      <property name="protocolVersion" value="${esc(server.protocolVersion)}"/>`)
  if (server.version) lines.push(`      <property name="serverVersion" value="${esc(server.version)}"/>`)
  lines.push(`    </properties>`)

  for (const r of results) {
    const cls = r.id.split('.')[0] ?? 'mcp-probe'
    const caseName = r.target ? `${r.title} (${r.target})` : r.title
    const attrs = `classname="${esc(cls)}" name="${esc(caseName)}"${r.ms !== undefined ? ` time="${(r.ms / 1000).toFixed(3)}"` : ''}`
    const body = [r.message, r.detail].filter(Boolean).join('\n\n')

    if (r.status === 'fail') {
      lines.push(`    <testcase ${attrs}>`)
      lines.push(`      <failure message="${esc(r.message ?? r.title)}" type="${esc(r.id)}">${esc(body)}</failure>`)
      lines.push(`    </testcase>`)
    } else if (r.status === 'skip') {
      lines.push(`    <testcase ${attrs}>`)
      lines.push(`      <skipped message="${esc(r.message ?? '')}"/>`)
      lines.push(`    </testcase>`)
    } else if (r.status === 'warn') {
      lines.push(`    <testcase ${attrs}>`)
      lines.push(`      <system-out>${esc(`[warning] ${body}`)}</system-out>`)
      lines.push(`    </testcase>`)
    } else {
      lines.push(`    <testcase ${attrs}/>`)
    }
  }

  if (report.stdoutNoise.length > 0) {
    lines.push(`    <system-err>${esc(`Non-JSON stdout:\n${report.stdoutNoise.join('\n')}`)}</system-err>`)
  }
  lines.push('  </testsuite>')
  lines.push('</testsuites>')
  return lines.join('\n') + '\n'
}
