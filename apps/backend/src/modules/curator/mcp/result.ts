/**
 * MCP tool result helpers. Every tool returns text content; failures surface as
 * a structured `{ error, code, detail? }` payload with `isError: true` rather
 * than throwing a raw exception across the protocol boundary (D2/D3).
 */
import { toErrorPayload } from '../core/errors.js';

export interface ToolResult {
  // Index signature matches the SDK's CallToolResult shape.
  [key: string]: unknown;
  content: { type: 'text'; text: string }[];
  isError?: boolean;
}

export function ok(data: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

export function fail(err: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(toErrorPayload(err), null, 2) }], isError: true };
}

/** Run a tool body, mapping success → ok and any thrown value → a structured error. */
export async function run(fn: () => Promise<unknown> | unknown): Promise<ToolResult> {
  try {
    return ok(await fn());
  } catch (err) {
    return fail(err);
  }
}
