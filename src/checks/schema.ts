import type { Check, CheckContext, CheckResult, JsonSchema, ToolDef } from '../types.js'
import { result, preview, isPlainObject, estimateTokens } from './util.js'

const SPEC = 'https://modelcontextprotocol.io/specification/2025-06-18/server/tools'

/** What hosts accept today. Anything else gets rejected at registration time. */
const NAME_PATTERN = /^[a-zA-Z0-9_-]{1,128}$/

/** Descriptions shorter than this cannot disambiguate a tool from its siblings. */
const MIN_DESCRIPTION_CHARS = 20

const PLACEHOLDER_DESCRIPTIONS = /^(todo|tbd|fixme|xxx|n\/?a|description|test|foo|bar|\.+)$/i

export const toolNameCheck: Check = {
  id: 'schema.tool_name',
  title: 'Tool names are valid and unique',
  severity: 'error',
  spec: SPEC,
  run(ctx: CheckContext): CheckResult[] {
    const out: CheckResult[] = []
    const seen = new Map<string, number>()

    for (const tool of ctx.tools) {
      const name = tool?.name
      if (typeof name !== 'string' || !name) {
        out.push(
          result('schema.tool_name.missing', 'Tool has a name', 'fail', 'error', {
            message: 'A tool in tools/list has no `name`.',
            detail: preview(tool),
            spec: SPEC,
          }),
        )
        continue
      }
      seen.set(name, (seen.get(name) ?? 0) + 1)
      if (!NAME_PATTERN.test(name)) {
        out.push(
          result('schema.tool_name.invalid', 'Tool name is host-compatible', 'fail', 'error', {
            target: name,
            message: `"${name}" contains characters hosts reject.`,
            detail: 'Allowed: letters, digits, underscore, hyphen; 1-128 chars. Spaces and dots break tool routing in several hosts.',
            spec: SPEC,
          }),
        )
      }
    }

    for (const [name, count] of seen) {
      if (count > 1) {
        out.push(
          result('schema.tool_name.duplicate', 'Tool names are unique', 'fail', 'error', {
            target: name,
            message: `"${name}" is listed ${count} times.`,
            detail: 'The model cannot address a duplicated name; whichever the host registers last silently wins.',
            spec: SPEC,
          }),
        )
      }
    }

    if (out.length === 0 && ctx.tools.length > 0) {
      out.push(
        result('schema.tool_name', 'Tool names are valid and unique', 'pass', 'error', {
          message: `${ctx.tools.length} tool${ctx.tools.length === 1 ? '' : 's'} checked.`,
        }),
      )
    }
    return out
  },
}

export const toolDescriptionCheck: Check = {
  id: 'schema.tool_description',
  title: 'Tools are described well enough for a model to choose between them',
  severity: 'warn',
  spec: SPEC,
  run(ctx: CheckContext): CheckResult[] {
    const out: CheckResult[] = []
    for (const tool of ctx.tools) {
      const name = tool?.name ?? '(unnamed)'
      const desc = tool?.description
      if (!desc || !desc.trim()) {
        out.push(
          result('schema.tool_description.missing', 'Tool has a description', 'fail', 'error', {
            target: name,
            message: 'No description.',
            detail:
              'The description is the only thing the model reads when deciding whether to call this tool. Without it the tool is effectively invisible.',
            spec: SPEC,
          }),
        )
        continue
      }
      const trimmed = desc.trim()
      if (PLACEHOLDER_DESCRIPTIONS.test(trimmed)) {
        out.push(
          result('schema.tool_description.placeholder', 'Description is not a placeholder', 'fail', 'error', {
            target: name,
            message: `Description is a placeholder: "${trimmed}"`,
            spec: SPEC,
          }),
        )
      } else if (trimmed.length < MIN_DESCRIPTION_CHARS) {
        out.push(
          result('schema.tool_description.short', 'Description is substantive', 'warn', 'warn', {
            target: name,
            message: `Only ${trimmed.length} chars: "${trimmed}"`,
            detail:
              'State what it does, when to use it, and what it returns. Models pick the wrong tool when two terse descriptions overlap.',
            spec: SPEC,
          }),
        )
      }
    }
    if (out.length === 0 && ctx.tools.length > 0) {
      out.push(result('schema.tool_description', 'Tools are described', 'pass', 'warn'))
    }
    return out
  },
}

function walkSchema(schema: JsonSchema, path: string, visit: (s: JsonSchema, p: string) => void, depth = 0): void {
  if (!isPlainObject(schema) || depth > 12) return
  visit(schema, path)
  if (isPlainObject(schema.properties)) {
    for (const [key, child] of Object.entries(schema.properties)) {
      walkSchema(child as JsonSchema, `${path}.${key}`, visit, depth + 1)
    }
  }
  if (schema.items && !Array.isArray(schema.items)) {
    walkSchema(schema.items as JsonSchema, `${path}[]`, visit, depth + 1)
  }
}

export const inputSchemaCheck: Check = {
  id: 'schema.input_schema',
  title: 'inputSchema is a usable JSON Schema',
  severity: 'error',
  spec: SPEC,
  run(ctx: CheckContext): CheckResult[] {
    const out: CheckResult[] = []

    for (const tool of ctx.tools) {
      const name = tool?.name ?? '(unnamed)'
      const schema = tool?.inputSchema

      if (!schema) {
        out.push(
          result('schema.input_schema.missing', 'Tool declares an inputSchema', 'fail', 'error', {
            target: name,
            message: 'No `inputSchema`.',
            detail: 'Without it the model has to guess the argument shape, and most hosts refuse to register the tool at all.',
            spec: SPEC,
          }),
        )
        continue
      }
      if (!isPlainObject(schema)) {
        out.push(
          result('schema.input_schema.malformed', 'inputSchema is an object', 'fail', 'error', {
            target: name,
            message: `inputSchema is ${Array.isArray(schema) ? 'an array' : typeof schema}, not an object.`,
            detail: preview(schema),
            spec: SPEC,
          }),
        )
        continue
      }
      if (schema.type !== 'object') {
        out.push(
          result('schema.input_schema.root_type', 'inputSchema root is type object', 'fail', 'error', {
            target: name,
            message: `Root \`type\` is ${schema.type === undefined ? 'absent' : `"${String(schema.type)}"`}, expected "object".`,
            detail: 'Tool arguments are always a named-argument object. Hosts validate against this before dispatching.',
            spec: SPEC,
          }),
        )
      }

      // required entries that do not exist are the most common schema bug:
      // the model is told to send a field that the server never reads.
      const props = isPlainObject(schema.properties) ? schema.properties : {}
      if (Array.isArray(schema.required)) {
        const orphans = schema.required.filter((r) => typeof r === 'string' && !(r in props))
        if (orphans.length > 0) {
          out.push(
            result('schema.input_schema.orphan_required', 'required fields exist in properties', 'fail', 'error', {
              target: name,
              message: `required lists ${orphans.map((o) => `"${o}"`).join(', ')}, which ${orphans.length === 1 ? 'is' : 'are'} not in properties.`,
              detail:
                'Strict validators reject every call to this tool, because the argument can never be supplied in a valid way.',
              spec: SPEC,
            }),
          )
        }
      }

      // Undescribed parameters force the model to infer meaning from the name.
      const undescribed: string[] = []
      walkSchema(schema, name, (s, p) => {
        if (p === name) return
        if (!s.description && !s.enum && s.type !== 'object') undescribed.push(p.slice(name.length + 1))
      })
      if (undescribed.length > 0) {
        out.push(
          result('schema.input_schema.undescribed_params', 'Parameters carry descriptions', 'warn', 'warn', {
            target: name,
            message: `${undescribed.length} parameter${undescribed.length === 1 ? '' : 's'} with no description: ${undescribed.slice(0, 6).join(', ')}${undescribed.length > 6 ? ', ...' : ''}`,
            detail: 'Parameter descriptions are how the model learns formats -- date layouts, id shapes, units, allowed ranges.',
            spec: SPEC,
          }),
        )
      }

      if (Object.keys(props).length === 0 && schema.type === 'object' && schema.additionalProperties !== false) {
        out.push(
          result('schema.input_schema.open_object', 'Schema constrains its arguments', 'warn', 'warn', {
            target: name,
            message: 'Schema is an object with no properties and additionalProperties is not false.',
            detail: 'This accepts anything. If the tool truly takes no arguments, set `additionalProperties: false` to say so.',
            spec: SPEC,
          }),
        )
      }
    }

    if (out.length === 0 && ctx.tools.length > 0) {
      out.push(result('schema.input_schema', 'inputSchema is usable', 'pass', 'error'))
    }
    return out
  },
}

/**
 * Every tool definition is re-sent on every single request for the whole
 * session. A bloated tool list is a permanent tax on the context window and
 * shows up directly on the user's bill -- but nothing in the toolchain
 * measures it, so it grows unnoticed.
 */
export const contextWeightCheck: Check = {
  id: 'schema.context_weight',
  title: 'Tool list does not dominate the context window',
  severity: 'warn',
  spec: SPEC,
  run(ctx: CheckContext): CheckResult[] {
    if (ctx.tools.length === 0) return []

    const perTool = ctx.tools
      .map((tool: ToolDef) => ({ name: tool?.name ?? '(unnamed)', tokens: estimateTokens(JSON.stringify(tool ?? {})) }))
      .sort((a, b) => b.tokens - a.tokens)
    const total = perTool.reduce((sum, t) => sum + t.tokens, 0)

    const heaviest = perTool
      .slice(0, 5)
      .map((t) => `  ${String(t.tokens).padStart(6)} tok  ${t.name}`)
      .join('\n')
    const detail = `Estimated at ~4 chars/token from the serialised tool definitions.\n\nHeaviest tools:\n${heaviest}\n\nThis cost is paid on every request for the lifetime of the session, not once.`

    const status = total > 10_000 ? 'fail' : total > 4_000 ? 'warn' : 'pass'
    const severity = total > 10_000 ? 'error' : 'warn'

    return [
      result('schema.context_weight', 'Tool list does not dominate the context window', status, severity, {
        message: `~${total.toLocaleString('en-US')} tokens across ${ctx.tools.length} tool${ctx.tools.length === 1 ? '' : 's'}${status === 'pass' ? '' : ` (budget: 4,000 warn / 10,000 fail)`}`,
        detail,
        spec: SPEC,
      }),
    ]
  },
}

export const schemaChecks: Check[] = [toolNameCheck, toolDescriptionCheck, inputSchemaCheck, contextWeightCheck]
