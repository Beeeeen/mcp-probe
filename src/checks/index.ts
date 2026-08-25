import type { Check } from '../types.js'
import { protocolChecks } from './protocol.js'
import { schemaChecks } from './schema.js'
import { robustnessChecks } from './robustness.js'
import { hygieneChecks } from './hygiene.js'

export { protocolChecks, schemaChecks, robustnessChecks, hygieneChecks }

/**
 * Order is deliberate. Protocol and schema checks are read-only and run first;
 * robustness checks push malformed traffic at the server, so anything that
 * would be perturbed by that has already run. Hygiene goes last because it
 * grades the byproducts -- stdout noise, stderr, liveness -- of everything
 * above it.
 */
export const allChecks: Check[] = [...protocolChecks, ...schemaChecks, ...robustnessChecks, ...hygieneChecks]

/** Ids match by prefix, so `--skip robustness` drops the whole group. */
export function selectChecks(checks: Check[], only?: string[], skip?: string[]): Check[] {
  let selected = checks
  if (only && only.length > 0) {
    selected = selected.filter((c) => only.some((o) => c.id === o || c.id.startsWith(o + '.')))
  }
  if (skip && skip.length > 0) {
    selected = selected.filter((c) => !skip.some((s) => c.id === s || c.id.startsWith(s + '.')))
  }
  return selected
}
