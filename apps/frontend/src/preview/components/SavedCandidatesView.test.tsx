/* @vitest-environment jsdom */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SavedCandidatesView } from "./SavedCandidatesView.js";
import type { SavedCandidatesResponse } from "../../features/curator/api.js";

const mockSavedResponse: SavedCandidatesResponse = {
  success: true,
  items: [
    {
      candidate: {
        id: "cand_apple_12345",
        source: "apple",
        title: "The Way of Kings",
        author: "Brandon Sanderson",
        coverUrl: "https://example.test/kings.jpg",
        description: "Epic fantasy novel.",
      },
      intent: {
        candidateId: "cand_apple_12345",
        actorId: "internal",
        intent: "want",
        revision: 1,
        createdAt: 1725900000000,
        updatedAt: 1725900000000,
      },
      ownership: "owned",
      isFinished: false,
    },
    {
      candidate: {
        id: "cand_audible_67890",
        source: "audible",
        title: "Words of Radiance",
        author: "Brandon Sanderson",
      },
      intent: {
        candidateId: "cand_audible_67890",
        actorId: "internal",
        intent: "later",
        revision: 2,
        createdAt: 1725900000000,
        updatedAt: 1725900300000,
      },
      ownership: "owned",
      isFinished: true,
    },
  ],
  totals: {
    all: 2,
    want: 1,
    later: 1,
    pass: 0,
  },
  counts: {
    all: 2,
    want: 1,
    later: 1,
    pass: 0,
  },
  actor: "internal",
  isShared: true,
};

let container: HTMLDivElement;
let root: Root;
let queryClient: QueryClient;
let fetchMock: ReturnType<typeof vi.fn>;

function LocationProbe({ onLocation }: { onLocation: (loc: ReturnType<typeof useLocation>) => void }) {
  const loc = useLocation();
  onLocation(loc);
  return null;
}

beforeEach(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;

  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });

  fetchMock = vi.fn().mockImplementation(async (url: string | URL) => {
    const urlStr = String(url);
    if (urlStr.includes("/api/candidates/saved")) {
      return new Response(JSON.stringify(mockSavedResponse), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (urlStr.includes("/api/candidates/intent/undo")) {
      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (urlStr.includes("/api/librarian/acquisitions/by-candidate/")) {
      return new Response(JSON.stringify({ success: true, data: null }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (urlStr.includes("/api/candidates/intent")) {
      return new Response(
        JSON.stringify({
          success: true,
          intent: { candidateId: "cand_apple_12345", intent: "later", revision: 2 },
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }
      );
    }
    return new Response(JSON.stringify({ error: "Not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(async () => {
  if (root) {
    await act(async () => root.unmount());
  }
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function flushPromises(iterations = 5) {
  for (let i = 0; i < iterations; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  }
}

describe("SavedCandidatesView", () => {
  it("renders saved candidates, totals, and badges", async () => {
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter>
            <SavedCandidatesView />
          </MemoryRouter>
        </QueryClientProvider>
      );
    });
    await flushPromises();

    expect(container.textContent).toContain("The Way of Kings");
    expect(container.textContent).toContain("Words of Radiance");
    expect(container.textContent).toContain("In Library");
    expect(container.textContent).toContain("Finished");
    expect(container.textContent).toContain("Shared decisions");

    const tabs = container.querySelectorAll('[role="tab"]');
    expect(tabs.length).toBe(4);
    expect(tabs[0]?.textContent).toContain("All Saved2");
    expect(tabs[1]?.textContent).toContain("Want1");
    expect(tabs[2]?.textContent).toContain("Later1");
    expect(tabs[3]?.textContent).toContain("Pass0");
  });

  it("renders empty state when no saved candidates are returned", async () => {
    fetchMock.mockImplementation(async () =>
      new Response(
        JSON.stringify({
          success: true,
          items: [],
          totals: { all: 0, want: 0, later: 0, pass: 0 },
          counts: { all: 0, want: 0, later: 0, pass: 0 },
          actor: "internal",
          isShared: true,
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }
      )
    );

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter>
            <SavedCandidatesView />
          </MemoryRouter>
        </QueryClientProvider>
      );
    });
    await flushPromises();

    expect(container.textContent).toContain("No titles saved here yet");
  });

  it("calls setIntentMutation on triage button click", async () => {
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter>
            <SavedCandidatesView />
          </MemoryRouter>
        </QueryClientProvider>
      );
    });
    await flushPromises();

    const laterBtn = container.querySelector<HTMLButtonElement>('.saved-triage-btn[title="Mark as Later"]');
    expect(laterBtn).not.toBeNull();

    await act(async () => {
      laterBtn?.click();
    });
    await flushPromises();

    const intentCall = fetchMock.mock.calls.find(([input]) =>
      String(input).includes("/api/candidates/intent") && !String(input).includes("/undo")
    );
    expect(intentCall).toBeDefined();
    const payload = JSON.parse(intentCall?.[1]?.body as string);
    expect(payload.candidateId).toBe("cand_apple_12345");
    expect(payload.intent).toBe("later");
    expect(payload.expectedRevision).toBe(1);
  });

  it("calls undo mutation on Undo button click", async () => {
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter>
            <SavedCandidatesView />
          </MemoryRouter>
        </QueryClientProvider>
      );
    });
    await flushPromises();

    const undoBtn = container.querySelector<HTMLButtonElement>('.saved-undo-btn[title="Undo triage decision"]');
    expect(undoBtn).not.toBeNull();

    await act(async () => {
      undoBtn?.click();
    });
    await flushPromises();

    const undoCall = fetchMock.mock.calls.find(([input]) =>
      String(input).includes("/api/candidates/intent/undo")
    );
    expect(undoCall).toBeDefined();
    const payload = JSON.parse(undoCall?.[1]?.body as string);
    expect(payload.candidateId).toBe("cand_apple_12345");
  });

  it("navigates to discover search with candidate query on Find click", async () => {
    let currentLocation: ReturnType<typeof useLocation> | undefined;

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter initialEntries={["/discover/saved"]}>
            <LocationProbe onLocation={(loc) => { currentLocation = loc; }} />
            <SavedCandidatesView />
          </MemoryRouter>
        </QueryClientProvider>
      );
    });
    await flushPromises();

    const findBtn = container.querySelector<HTMLButtonElement>('.saved-search-btn[title="Find on AudioShelf acquisition sources"]');
    expect(findBtn).not.toBeNull();

    await act(async () => {
      findBtn?.click();
    });
    await flushPromises();

    expect(currentLocation?.pathname).toBe("/discover/search");
    expect(currentLocation?.search).toBe("?q=The%20Way%20of%20Kings%20Brandon%20Sanderson&candidateId=cand_apple_12345");
  });

  it("renders live acquisition progress and badges", async () => {
    fetchMock.mockImplementation(async (url: string | URL) => {
      const urlStr = String(url);
      if (urlStr.includes("/api/candidates/saved")) {
        return new Response(JSON.stringify(mockSavedResponse), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (urlStr.includes("/api/librarian/acquisitions/by-candidate/cand_apple_12345")) {
        return new Response(
          JSON.stringify({
            success: true,
            data: {
              id: "acq_123",
              candidateId: "cand_apple_12345",
              bookUrl: "https://audiobookbay.lu/test",
              progress: 0.65,
              status: "downloading",
              retryCount: 0,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      if (urlStr.includes("/api/librarian/acquisitions/by-candidate/cand_audible_67890")) {
        return new Response(
          JSON.stringify({
            success: true,
            data: {
              id: "acq_456",
              candidateId: "cand_audible_67890",
              bookUrl: "https://audiobookbay.lu/test2",
              status: "shelved",
              audiobookshelfItemId: "abs_789",
              retryCount: 0,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      return new Response(JSON.stringify({ success: true, data: null }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter>
            <SavedCandidatesView />
          </MemoryRouter>
        </QueryClientProvider>
      );
    });
    await flushPromises();

    expect(container.textContent).toContain("Downloading 65%");
    expect(container.textContent).toContain("Shelved");
    expect(container.querySelector(".saved-acquisition-progress-bar")).not.toBeNull();
  });

  it("handles failed acquisition with retry trigger", async () => {
    let retryCalled = false;
    fetchMock.mockImplementation(async (url: string | URL) => {
      const urlStr = String(url);
      if (urlStr.includes("/api/candidates/saved")) {
        return new Response(JSON.stringify(mockSavedResponse), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (urlStr.includes("/api/librarian/acquisitions/by-candidate/cand_apple_12345")) {
        return new Response(
          JSON.stringify({
            success: true,
            data: {
              id: "acq_fail_1",
              candidateId: "cand_apple_12345",
              bookUrl: "https://audiobookbay.lu/fail",
              status: "failed",
              detail: "Connection timed out",
              retryCount: 0,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      if (urlStr.includes("/api/librarian/acquisitions/acq_fail_1/retry")) {
        retryCalled = true;
        return new Response(
          JSON.stringify({
            success: true,
            data: {
              id: "acq_fail_1",
              status: "downloading",
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      return new Response(JSON.stringify({ success: true, data: null }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter>
            <SavedCandidatesView />
          </MemoryRouter>
        </QueryClientProvider>
      );
    });
    await flushPromises();

    expect(container.textContent).toContain("Failed");
    expect(container.textContent).toContain("Connection timed out");

    const retryBtn = container.querySelector<HTMLButtonElement>(".saved-acquisition-retry-btn");
    expect(retryBtn).not.toBeNull();

    await act(async () => {
      retryBtn?.click();
    });
    await flushPromises();

    expect(retryCalled).toBe(true);
  });

  it("displays conflict banner when set intent hits revision conflict", async () => {
    fetchMock.mockImplementation(async (url: string | URL) => {
      const urlStr = String(url);
      if (urlStr.includes("/api/candidates/saved")) {
        return new Response(JSON.stringify(mockSavedResponse), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (urlStr.includes("/api/librarian/acquisitions/by-candidate/")) {
        return new Response(JSON.stringify({ success: true, data: null }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (urlStr.includes("/api/candidates/intent")) {
        return new Response(
          JSON.stringify({
            error: "Revision conflict for candidate cand_apple_12345",
          }),
          {
            status: 409,
            headers: { "Content-Type": "application/json" },
          }
        );
      }
      return new Response(JSON.stringify({ error: "Not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter>
            <SavedCandidatesView />
          </MemoryRouter>
        </QueryClientProvider>
      );
    });
    await flushPromises();

    const passBtn = container.querySelector<HTMLButtonElement>('.saved-triage-btn[title="Mark as Pass"]');
    expect(passBtn).not.toBeNull();

    await act(async () => {
      passBtn?.click();
    });
    await flushPromises();

    expect(container.textContent).toContain("This item was updated in another window");
  });
});

