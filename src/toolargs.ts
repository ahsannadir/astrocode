/**
 * Tool-argument repair for AstroCode.
 *
 * "Reliability runs through the tool interface" (Anthropic, *Writing
 * effective tools for agents*). Models — especially smaller and local ones —
 * emit tool arguments that are *almost* JSON: fenced with ```json, trailing
 * commas, single quotes, bare newlines inside strings, or numbers-as-strings
 * ("5" instead of 5). Failing all of these at the harness layer wastes a full
 * provider turn; repairing them here is free.
 *
 * Two layers:
 *   1. repairToolArgsJson() — recover a JSON object from malformed text.
 *   2. coerceArgsToSchema() — fix type drift against the tool's schema
 *      ("5" → 5, "true" → true, single object → 1-element array, etc.) so
 *      handlers never see stringified numbers.
 */
import type { ToolFunctionSchema } from './types.js';

/** Strip markdown code fences and stray prose around a JSON payload. */
function stripFences(raw: string): string {
  let t = raw.trim();
  const fence = t.match(/^```[a-zA-Z0-9_-]*\s*([\s\S]*?)\s*```$/);
  if (fence) t = fence[1].trim();
  // Some models prefix prose: 'Here are the args: {...}'
  const firstBrace = t.indexOf('{');
  if (firstBrace > 0 && !t.startsWith('{')) t = t.slice(firstBrace);
  return t.trim();
}

/** Fix common JSON syntax drift (single quotes, trailing commas, raw newlines). */
function fixJsonSyntax(t: string): string {
  return (
    t
      // Trailing commas before } or ]
      .replace(/,\s*([}\]])/g, '$1')
      // Smart quotes → straight quotes
      .replace(/[\u201c\u201d]/g, '"')
      .replace(/[\u2018\u2019]/g, "'")
  );
}

/**
 * Single-pass character scanner that repairs unescaped newlines and single
 * quotes inside string literals — the two most common model slips that a
 * regex cannot fix safely.
 */
function rescanStrings(t: string): string {
  const out: string[] = [];
  let inString = false;
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (!inString) {
      if (ch === '"') inString = true;
      out.push(ch);
      continue;
    }
    // Inside a string literal.
    if (ch === '\\') {
      out.push(ch);
      const next = t[i + 1];
      if (next !== undefined) {
        out.push(next);
        i++;
      }
      continue;
    }
    if (ch === '"') {
      inString = false;
      out.push(ch);
      continue;
    }
    if (ch === '\n') {
      out.push('\\n');
      continue;
    }
    if (ch === '\r') {
      out.push('\\r');
      continue;
    }
    if (ch === '\t') {
      out.push('\\t');
      continue;
    }
    out.push(ch);
  }
  return out.join('');
}

/** Parse `args` into an object; returns undefined when unrecoverable. */
export function repairToolArgsJson(raw: string): Record<string, unknown> | undefined {
  const text = String(raw ?? '').trim();
  if (!text) return {};
  const direct = tryParse(text);
  if (direct) return direct;

  const stripped = stripFences(text);
  const strippedParsed = tryParse(stripped);
  if (strippedParsed) return strippedParsed;

  const fixed = fixJsonSyntax(stripped);
  const fixedParsed = tryParse(fixed);
  if (fixedParsed) return fixedParsed;

  const rescanned = rescanStrings(fixed);
  const rescannedParsed = tryParse(rescanned);
  if (rescannedParsed) return rescannedParsed;

  // Last resort: convert single-quoted strings to double-quoted
  // ({'path': 'a.ts'} → {"path": "a.ts"}) and try once more.
  const dq = convertSingleQuotes(rescanned);
  if (dq !== rescanned) {
    const dqParsed = tryParse(dq);
    if (dqParsed) return dqParsed;
  }
  return undefined;
}

/**
 * Rewrite single-quoted string literals as double-quoted ones, escaping
 * embedded double quotes and raw newlines. Doubles as a detector: returns
 * the input unchanged when no single-quoted strings were present.
 */
function convertSingleQuotes(t: string): string {
  let changed = false;
  const out: string[] = [];
  let i = 0;
  while (i < t.length) {
    const ch = t[i];
    if (ch === '"') {
      // Copy an existing double-quoted string verbatim.
      out.push(ch);
      i++;
      while (i < t.length) {
        const c = t[i];
        out.push(c);
        i++;
        if (c === '\\' && i < t.length) {
          out.push(t[i]);
          i++;
        } else if (c === '"') {
          break;
        }
      }
      continue;
    }
    if (ch === "'") {
      changed = true;
      out.push('"');
      i++;
      while (i < t.length && t[i] !== "'") {
        const c = t[i];
        if (c === '"') out.push('\\"');
        else if (c === '\\' && i + 1 < t.length && t[i + 1] === "'") {
          out.push("'");
          i++;
        } else if (c === '\n') out.push('\\n');
        else if (c === '\r') out.push('\\r');
        else if (c === '\t') out.push('\\t');
        else out.push(c);
        i++;
      }
      out.push('"');
      i++; // closing quote
      continue;
    }
    out.push(ch);
    i++;
  }
  return changed ? out.join('') : t;
}

function tryParse(t: string): Record<string, unknown> | undefined {
  try {
    const v = JSON.parse(t);
    if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
    // A bare array or scalar is not valid tool args — wrap what we can.
    if (Array.isArray(v)) return { items: v };
    return undefined;
  } catch {
    return undefined;
  }
}

/** Coerce a scalar against an expected JSON type name. */
function coerceValue(value: unknown, expected: string | undefined): unknown {
  if (expected === undefined) return value;
  switch (expected) {
    case 'number': {
      if (typeof value === 'string') {
        const n = Number(value.trim());
        if (Number.isFinite(n)) return n;
      }
      if (typeof value === 'boolean') return value ? 1 : 0;
      return value;
    }
    case 'boolean': {
      if (typeof value === 'string') {
        const s = value.trim().toLowerCase();
        if (['true', 'yes', '1'].includes(s)) return true;
        if (['false', 'no', '0'].includes(s)) return false;
      }
      if (typeof value === 'number') return value !== 0;
      return value;
    }
    case 'string': {
      if (typeof value === 'number' || typeof value === 'boolean') return String(value);
      return value;
    }
    case 'array': {
      if (typeof value === 'string') {
        // JSON-encoded array string: '[1,2]' → [1,2]
        const parsed = tryParse(value);
        if (parsed && Array.isArray((parsed as any).items)) return (parsed as any).items;
        // Comma-separated fallback (typical for tool-name lists)
        const parts = value.split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
        if (parts.length > 0) return parts;
      }
      if (value !== null && typeof value === 'object') return [value];
      return value;
    }
    case 'object': {
      if (typeof value === 'string') {
        const parsed = repairToolArgsJson(value);
        if (parsed) return parsed;
      }
      return value;
    }
    default:
      return value;
  }
}

/**
 * Fix type drift in `args` against the tool schema: numbers passed as
 * strings, booleans as strings, single objects where arrays are expected,
 * and JSON-encoded arrays/objects.
 */
export function coerceArgsToSchema(
  args: Record<string, unknown>,
  schema: ToolFunctionSchema,
): Record<string, unknown> {
  const props = schema.parameters?.properties ?? {};
  const out: Record<string, unknown> = { ...args };
  for (const [key, value] of Object.entries(out)) {
    const prop = props[key];
    if (!prop || value === null || value === undefined) continue;
    out[key] = coerceValue(value, prop.type);
  }
  return out;
}
