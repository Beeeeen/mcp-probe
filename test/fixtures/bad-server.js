#!/usr/bin/env node
/**
 * A deliberately broken MCP server. Every defect here is one seen in real
 * published servers, and each maps to exactly one mcp-probe check, so the
 * suite can assert that the check fires.
 *
 * DO NOT "fix" anything in this file. The bugs are the fixture.
 */
import { createInterface } from 'node:readline'

// DEFECT 1: a startup banner on stdout. stdout is the protocol channel, so
// this single line desynchronises every client that ever connects.
console.log('bad-server starting up...')

const TOOLS = [
  {
    // DEFECT 2: no description at all -- the model cannot tell what this does.
    name: 'mystery',
    inputSchema: { type: 'object', properties: { x: { type: 'string' } } },
  },
  {
    name: 'search files',                       // DEFECT 3: a space in the name
    description: 'TODO',                        // DEFECT 4: placeholder description
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query', 'directory'],         // DEFECT 5: "directory" is not a property
    },
  },
  {
    name: 'dup',
    description: 'The first tool that claims this name. Only one of the two can ever be reachable.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    // DEFECT 6: the same name twice; whichever registers last silently wins.
    name: 'dup',
    description: 'The second tool that claims this name, with completely different behaviour.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'delete_everything',
    description: 'Deletes the named record permanently. This is irreversible.',
    // DEFECT 7: no validation happens at call time (see below), despite the
    // schema declaring `target` as required.
    inputSchema: {
      type: 'object',
      properties: { target: { type: 'string' } },
      required: ['target'],
    },
  },
]

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n')
}

createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return
  let msg
  try {
    msg = JSON.parse(line)
  } catch {
    return // DEFECT 8: parse errors are swallowed instead of answered with -32700
  }
  const { id, method, params } = msg
  if (id === undefined || id === null) return

  if (method === 'initialize') {
    return send({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: '2025-06-18',
        // DEFECT 9: declares resources, but resources/list is not implemented.
        capabilities: { tools: {}, resources: {} },
        serverInfo: { name: 'bad-fixture' },   // DEFECT 10: no version
      },
    })
  }
  if (method === 'tools/list') return send({ jsonrpc: '2.0', id, result: { tools: TOOLS } })

  if (method === 'tools/call') {
    // DEFECT 11: no argument validation whatsoever. Required arguments are
    // never checked, so `delete_everything` "succeeds" with no target.
    return send({
      jsonrpc: '2.0',
      id,
      result: { content: [{ type: 'text', text: `ran ${params?.name} with ${JSON.stringify(params?.arguments ?? {})}` }] },
    })
  }

  // DEFECT 12: unknown methods return success rather than -32601, so a typo in
  // a method name looks like it worked.
  return send({ jsonrpc: '2.0', id, result: { ok: true } })
})
