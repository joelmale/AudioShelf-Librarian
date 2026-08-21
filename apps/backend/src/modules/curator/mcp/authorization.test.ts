import { describe, expect, it } from "vitest";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import {
  AUTHORIZED_TOOL_NAMES,
  TOOL_MINIMUM_ROLE,
  authorizeTool,
  roleFromAuthInfo,
  withToolAuthorization,
} from "./authorization.js";
import { buildMcpServer } from "./server.js";
import type { McpServices } from "./services.js";

function auth(role: string | undefined): AuthInfo | undefined {
  if (role === undefined) return undefined;
  return { token: "", clientId: "test", scopes: [], extra: { role } };
}

/**
 * A structural stand-in for the curator service bundle. The wiring tests only
 * need registration to succeed; no tool body runs against it.
 */
const stubServices = {
  config: { taggingConcurrency: 1, absLibraryId: "lib-1" },
  db: {},
  absClient: {},
  llmClient: {},
  logger: { debug() {}, info() {}, warn() {}, error() {} },
  actionLog: {},
  operations: {},
} as unknown as McpServices;

describe("authorizeTool", () => {
  it("allows a role that exactly meets the requirement", () => {
    expect(authorizeTool("query_library", auth("viewer")).allowed).toBe(true);
  });

  it("allows a role above the requirement", () => {
    expect(authorizeTool("tag_books", auth("administrator")).allowed).toBe(true);
  });

  it("denies a role below the requirement", () => {
    const decision = authorizeTool("sync_abs_library", auth("curator"));

    expect(decision.allowed).toBe(false);
    expect(decision.required).toBe("librarian");
    expect(decision.actual).toBe("curator");
  });

  it("denies an unknown tool rather than defaulting to permissive", () => {
    const decision = authorizeTool("delete_everything", auth("administrator"));

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toMatch(/no authorization policy/i);
  });

  it("denies when no role is attached at all", () => {
    expect(authorizeTool("query_library", undefined).allowed).toBe(false);
  });

  it("denies an unrecognized role string", () => {
    expect(authorizeTool("query_library", auth("superuser")).allowed).toBe(false);
    expect(roleFromAuthInfo(auth("superuser"))).toBeNull();
  });

  it("does not let a curator reach administrator-gated encode tools", () => {
    // The specific escalation this design exists to prevent: every MCP call is
    // one POST to one path, which the REST rules would classify as `curator`.
    for (const tool of ["scan_encodable", "queue_m4b_encode"] as const) {
      expect(authorizeTool(tool, auth("curator")).allowed).toBe(false);
      expect(authorizeTool(tool, auth("administrator")).allowed).toBe(true);
    }
  });
});

describe("MCP tool surface", () => {
  /** Names actually registered on a real McpServer, read back via the SDK. */
  function registeredToolNames(): string[] {
    const server = buildMcpServer(stubServices);
    const registered = (server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools;
    return Object.keys(registered).sort();
  }

  it("registers every tool the policy table covers, and no others", () => {
    // Drift guard in both directions: a new tool without a policy entry fails
    // here rather than being silently denied in production, and a stale entry
    // for a removed tool is also caught.
    expect(registeredToolNames()).toEqual([...AUTHORIZED_TOOL_NAMES].sort());
  });

  it("registers all 14 tools", () => {
    expect(registeredToolNames()).toHaveLength(14);
    expect(Object.keys(TOOL_MINIMUM_ROLE)).toHaveLength(14);
  });

  it("includes the privileged tools the guard exists for", () => {
    expect(registeredToolNames()).toEqual(
      expect.arrayContaining(["sync_abs_library", "push_all_approved", "queue_m4b_encode", "scan_encodable"]),
    );
  });
});

describe("withToolAuthorization", () => {
  /** Minimal McpServer-shaped double capturing what registerTool receives. */
  function fakeServer() {
    const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();
    const server = {
      registerTool(name: string, _config: unknown, handler: (...args: unknown[]) => Promise<unknown>) {
        handlers.set(name, handler);
      },
      other() {
        return "untouched";
      },
    };
    return { server, handlers };
  }

  it("blocks an under-privileged call before the tool body runs", async () => {
    const { server, handlers } = fakeServer();
    let ran = false;
    withToolAuthorization(server as never).registerTool("sync_abs_library", {}, async () => {
      ran = true;
      return { content: [] };
    });

    const result = (await handlers.get("sync_abs_library")!({}, { authInfo: auth("curator") })) as {
      isError?: boolean;
      content: { text: string }[];
    };

    expect(ran).toBe(false);
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text).code).toBe("FORBIDDEN");
  });

  it("runs the tool body when the role suffices", async () => {
    const { server, handlers } = fakeServer();
    let ran = false;
    withToolAuthorization(server as never).registerTool("query_library", {}, async () => {
      ran = true;
      return { content: [{ type: "text", text: "ok" }] };
    });

    await handlers.get("query_library")!({}, { authInfo: auth("viewer") });

    expect(ran).toBe(true);
  });

  it("finds the extra argument for a tool invoked with no input schema", async () => {
    const { server, handlers } = fakeServer();
    let ran = false;
    withToolAuthorization(server as never).registerTool("get_tagging_status", {}, async () => {
      ran = true;
      return { content: [] };
    });

    // Zero-arg tools are called with only the extra object.
    await handlers.get("get_tagging_status")!({ authInfo: auth("viewer") });

    expect(ran).toBe(true);
  });

  it("passes other properties through to the underlying server", () => {
    const { server } = fakeServer();
    expect((withToolAuthorization(server as never) as unknown as { other(): string }).other()).toBe("untouched");
  });
});
