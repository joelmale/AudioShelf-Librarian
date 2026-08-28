/**
 * MCP adapter for the librarian's internal retrieval registry.
 *
 * This file intentionally contains no retrieval logic. The internal Desk loop
 * and MCP clients both execute the same `LIBRARIAN_TOOLS` entries, so fixes to
 * filtering, ranking, coverage, and error behavior cannot drift by surface.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ZodError, type z } from 'zod';

import {
  LIBRARIAN_TOOLS,
  type LibrarianTool,
  type LibrarianToolDeps,
} from '../../core/librarian/tools.js';
import { NotFoundError, ValidationError } from '../../core/errors.js';
import { run, type ToolResult } from '../result.js';
import type { McpServices } from '../services.js';

type ErasedLibrarianTool = LibrarianTool<unknown, unknown>;

const ERASED_TOOLS = LIBRARIAN_TOOLS as unknown as readonly ErasedLibrarianTool[];

export function librarianToolEntry(name: string): ErasedLibrarianTool {
  const entry = ERASED_TOOLS.find((tool) => tool.name === name);
  if (!entry) throw new NotFoundError(`No librarian tool named ${name}`);
  return entry;
}

/** The SDK's JSON-schema converter reduces a top-level ZodEffects (created by
 * cross-field range refinements) to an empty object schema. Register the
 * refined object's underlying shape for discovery/first-pass validation;
 * `runLibrarianTool` always parses the original refined registry schema again
 * before invoking the handler, so the cross-field rules still fail closed. */
export function librarianMcpInputSchema(schema: z.ZodType<unknown>): z.ZodType<unknown> {
  let current = schema as z.ZodType<unknown> & { innerType?: () => z.ZodType<unknown> };
  while (current.innerType) current = current.innerType() as typeof current;
  return current;
}

function toolDeps(services: McpServices): LibrarianToolDeps {
  return {
    db: services.db,
    embeddingModel: services.config.embeddingModel,
    embeddingCreator: services.embeddingCreator,
  };
}

/** Invoke one registry entry with the same boundary validation used by the
 * internal tool loop. Exported solely for the deprecated `query_library`
 * compatibility alias, which must remain a delegation rather than a fork. */
export function runLibrarianTool(
  name: string,
  services: McpServices,
  input: unknown
): Promise<ToolResult> {
  return run(async () => {
    const entry = librarianToolEntry(name);
    let parsed: unknown;
    try {
      parsed = entry.inputSchema.parse(input);
    } catch (error) {
      if (error instanceof ZodError) {
        throw new ValidationError(`Invalid input for librarian tool "${name}"`, error.issues);
      }
      throw error;
    }
    return entry.handler(toolDeps(services), parsed);
  });
}

/** Register the exact five internal librarian tools over MCP. Names,
 * descriptions, and schemas are registry-owned and are not copied here. */
export function registerLibrarianTools(server: McpServer, services: McpServices): void {
  for (const entry of ERASED_TOOLS) {
    server.registerTool(
      entry.name,
      {
        description: entry.description,
        inputSchema: librarianMcpInputSchema(entry.inputSchema as z.ZodType<unknown>),
        annotations: { readOnlyHint: true },
      },
      async (args) => runLibrarianTool(entry.name, services, args)
    );
  }
}
