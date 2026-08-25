import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { run, exitCodeFor } from '../dist/run.js'
import { renderJUnit } from '../dist/report/junit.js'
import { renderTerminal } from '../dist/report/terminal.js'
import { allChecks, selectChecks } from '../dist/checks/index.js'

const here = dirname(fileURLToPath(import.meta.url))
const fixture = (name) => join(here, 'fixtures', name)

const stdio = (file) => ({ kind: 'stdio', command: process.execPath, args: [fixture(file)] })

/** Every id emitted by a run, so tests can assert a specific check fired. */
const idsWithStatus = (report, status) => report.results.filter((r) => r.status === status).map((r) => r.id)

test('a conforming server passes cleanly', async () => {
  const report = await run(stdio('good-server.js'))

  assert.equal(report.summary.fail, 0, `unexpected failures: ${JSON.stringify(idsWithStatus(report, 'fail'))}`)
  assert.equal(report.summary.warn, 0, `unexpected warnings: ${JSON.stringify(idsWithStatus(report, 'warn'))}`)
  assert.ok(report.summary.pass > 10, 'expected a substantial number of passing checks')
  assert.equal(exitCodeFor(report, false), 0)
  assert.equal(exitCodeFor(report, true), 0, 'a clean server must also pass under --strict')
})

test('a conforming server reports its identity', async () => {
  const report = await run(stdio('good-server.js'))
  assert.equal(report.server.name, 'good-fixture')
  assert.equal(report.server.version, '1.0.0')
  assert.equal(report.server.protocolVersion, '2025-06-18')
})

test('every defect in the broken fixture is caught', async () => {
  const report = await run(stdio('bad-server.js'))
  const failed = new Set(idsWithStatus(report, 'fail'))
  const warned = new Set(idsWithStatus(report, 'warn'))

  // One assertion per planted defect, named so a regression says which one.
  const expectedFailures = {
    'stdout pollution (console.log on the protocol channel)': 'hygiene.stdout_purity',
    'tool with no description': 'schema.tool_description.missing',
    'placeholder description': 'schema.tool_description.placeholder',
    'tool name containing a space': 'schema.tool_name.invalid',
    'duplicate tool name': 'schema.tool_name.duplicate',
    'required field absent from properties': 'schema.input_schema.orphan_required',
    'capability declared but not implemented': 'protocol.capabilities.resources',
    'unknown method answered with success': 'protocol.unknown_method',
    'unknown tool answered with success': 'robustness.unknown_tool',
    'required arguments not validated': 'robustness.invalid_args.missing_required',
  }
  for (const [defect, id] of Object.entries(expectedFailures)) {
    assert.ok(failed.has(id), `not detected -- ${defect} (expected a failure with id "${id}")`)
  }

  assert.ok(warned.has('protocol.handshake.serverinfo'), 'missing serverInfo.version should warn')
  assert.ok(warned.has('schema.input_schema.undescribed_params'), 'undescribed parameters should warn')
  assert.ok(warned.has('robustness.invalid_args.wrong_types'), 'unvalidated argument types should warn')

  assert.equal(exitCodeFor(report, false), 1)
})

test('the offending stdout line is quoted back verbatim', async () => {
  const report = await run(stdio('bad-server.js'))
  const finding = report.results.find((r) => r.id === 'hygiene.stdout_purity')

  assert.equal(finding.status, 'fail')
  assert.ok(report.stdoutNoise.includes('bad-server starting up...'), 'the raw line must be preserved for the user')
  assert.match(finding.detail, /bad-server starting up/)
  assert.match(finding.detail, /stderr/, 'the finding should say how to fix it')
})

test('identical findings from duplicate tools are reported once', async () => {
  const report = await run(stdio('bad-server.js'))
  const keys = report.results.map((r) => `${r.id}|${r.target ?? ''}|${r.message ?? ''}`)
  assert.equal(new Set(keys).size, keys.length, 'the report contains duplicate lines')
})

test('a server that cannot start is a result, not an exception', async () => {
  const report = await run({ kind: 'stdio', command: process.execPath, args: [fixture('does-not-exist.js')] })

  assert.equal(report.summary.fail, 1)
  assert.equal(report.results[0].id, 'connect')
  assert.equal(exitCodeFor(report, false), 1)
})

test('tools are never invoked unless asked', async () => {
  // `delete_everything` in the bad fixture echoes what it was called with, so
  // a valid-argument invocation would be visible in the results.
  const report = await run(stdio('bad-server.js'))
  const sizeCheck = report.results.find((r) => r.id === 'robustness.response_size')

  assert.equal(sizeCheck.status, 'skip')
  assert.match(sizeCheck.message, /--call-tools/)
})

test('--safe-tool opts a single tool into being invoked', async () => {
  const report = await run(stdio('good-server.js'), { safeTools: ['echo'] })
  const sizeCheck = report.results.find((r) => r.id.startsWith('robustness.response_size'))
  assert.notEqual(sizeCheck.status, 'skip', 'naming a safe tool should enable the response-size measurement')
})

test('JUnit output is well-formed XML that reports the failures', async () => {
  const report = await run(stdio('bad-server.js'))
  const xml = renderJUnit(report)

  assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-8"\?>/)
  const failures = xml.match(/<failure /g) ?? []
  assert.equal(failures.length, report.summary.fail)
  assert.ok(!/[\x00-\x08\x0B\x0C\x0E-\x1F]/.test(xml), 'control characters would make the XML unparseable')
  // Quotes and angle brackets in server payloads must not break the document.
  assert.ok(!/<failure message="[^"]*"[^>]*>[^<]*<[^/]/.test(xml), 'payload text leaked unescaped markup')
})

test('the terminal report hides warning detail until --verbose', async () => {
  const report = await run(stdio('bad-server.js'))
  const plain = renderTerminal(report)
  const verbose = renderTerminal(report, { verbose: true })

  assert.ok(verbose.length > plain.length)
  assert.match(plain, /not expanded/)
  assert.ok(!plain.includes('Parameter descriptions are how the model learns formats'))
  assert.ok(verbose.includes('Parameter descriptions are how the model learns formats'))
})

test('--only and --skip select checks by prefix', async () => {
  assert.ok(selectChecks(allChecks, ['schema']).every((c) => c.id.startsWith('schema')))
  assert.ok(selectChecks(allChecks, undefined, ['schema']).every((c) => !c.id.startsWith('schema')))
  assert.equal(selectChecks(allChecks, ['protocol.ping']).length, 1)
  assert.equal(selectChecks(allChecks, ['nothing.matches.this']).length, 0)
})

test('skipping a group removes its results from the run', async () => {
  const report = await run(stdio('bad-server.js'), { skip: ['schema', 'robustness'] })
  assert.ok(!report.results.some((r) => r.id.startsWith('schema.')))
  assert.ok(!report.results.some((r) => r.id.startsWith('robustness.')))
  assert.ok(report.results.some((r) => r.id.startsWith('hygiene.')))
})

test('check ids are unique and dotted', () => {
  const ids = allChecks.map((c) => c.id)
  assert.equal(new Set(ids).size, ids.length, 'two checks share an id')
  for (const id of ids) assert.match(id, /^[a-z_]+\.[a-z_]+$/, `malformed check id: ${id}`)
})
