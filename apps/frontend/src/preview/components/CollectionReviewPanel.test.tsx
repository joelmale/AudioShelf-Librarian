// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CollectionReviewPanel } from "./CollectionReviewPanel.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const alpha = { id: "a", title: "Alpha", author: "Example", files: ["Alpha/01.mp3", "Alpha/02.mp3"], extras: [], evidence: ["Album and folder agree"] };
const beta = { id: "b", title: "Beta", author: "Example", files: ["Beta/01.m4b"], extras: [], evidence: [] };
const preview: { fingerprint: string; candidates: Array<typeof alpha & { ready?: boolean; duplicate?: string }>; unassigned: string[]; extras: string[]; warnings: string[]; progress: Array<{ id: string; title: string; author: string; files: string[]; state: string; message?: string }>; counts: { imported: number; held: number; failed: number; remaining: number } } = {
  fingerprint: "revision-1",
  candidates: [alpha, beta],
  unassigned: ["Extras/untagged.mp3"],
  extras: ["readme.txt"],
  warnings: [],
  progress: [] as Array<{ id: string; title: string; author: string; files: string[]; state: string; message?: string }>,
  counts: { imported: 0, held: 0, failed: 0, remaining: 2 },
};

let root: Root | undefined;
function response(data: unknown, status = 200) {
  return new Response(JSON.stringify(status < 400 ? { data } : { error: data }), { status });
}

function button(label: string, within: ParentNode = document) {
  const result = [...within.querySelectorAll("button")].find((item) => (item.getAttribute("aria-label") ?? item.textContent?.trim()) === label);
  if (!result) throw new Error("Missing button " + label);
  return result;
}

function group(title: string) {
  const result = [...document.querySelectorAll("legend")].find((item) => item.textContent === title)?.parentElement;
  if (!result) throw new Error("Missing group " + title);
  return result;
}

function checkbox(label: string, within: ParentNode = document) {
  const result = [...within.querySelectorAll("label")].find((item) => item.textContent?.trim() === label)?.querySelector("input");
  if (!result) throw new Error("Missing checkbox " + label);
  return result;
}

async function click(node: HTMLElement) { await act(async () => node.click()); }

async function openReview(initial = preview) {
  const fetchMock = vi.spyOn(globalThis, "fetch")
    .mockRejectedValue(new Error("Unexpected collection request"))
    .mockResolvedValueOnce(response({ path: "/inbox", partial: false, rows: [{ name: "Test collection", collectionId: "collection-a", status: "review", kind: "directory", audioFiles: 3, otherFiles: 0, partial: false }] }))
    .mockResolvedValueOnce(response(initial));
  const element = document.createElement("div");
  document.body.append(element);
  root = createRoot(element);
  await act(async () => root?.render(<CollectionReviewPanel />));
  await click(button("Review Test collection"));
  return fetchMock;
}

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("Collection review", () => {
  it("moves selected tracks and sends only the explicitly approved group", async () => {
    const fetchMock = await openReview();
    expect(document.body.textContent).toContain("Album and folder agree");
    expect(document.body.textContent).toContain("readme.txt");
    expect(button("Import selected books (0)").disabled).toBe(true);
    await click(checkbox("Alpha/02.mp3", group("Alpha")));
    const destination = document.querySelector("select")!;
    await act(async () => { destination.value = "b"; destination.dispatchEvent(new Event("change", { bubbles: true })); });
    await click(button("Move selected files (1)"));
    await click(checkbox("Select for import", group("Beta")));
    const selectedFiles = ["Beta/01.m4b", "Alpha/02.mp3"];
    fetchMock.mockResolvedValueOnce(response({ operationId: "op" }, 202))
      .mockResolvedValueOnce(response({ state: "running", processed: 0, total: 1 }))
      .mockResolvedValueOnce(response({ state: "complete", preview: {
      ...preview,
      progress: [{ ...beta, files: selectedFiles, state: "imported" }],
      counts: { imported: 1, held: 0, failed: 0, remaining: 1 },
    } }));
    await click(button("Import selected books (1)"));
    expect(fetchMock).toHaveBeenCalledWith("/api/librarian/collections/collection-a", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ fingerprint: "revision-1", groups: [{ title: "Beta", author: "Example", files: selectedFiles }] }),
    }));
    expect(document.body.textContent).toContain("Processed 0 of 1 book");
    await act(async () => { await new Promise(resolve => window.setTimeout(resolve, 775)); });
    expect(document.querySelector('[role="status"]')?.textContent).toContain("1 Imported");
    expect(group("Alpha").textContent).toContain("Alpha/01.mp3");
    expect(group("Alpha").textContent).not.toContain("Alpha/02.mp3");
  });

  it("retries only the persisted held book after a partial import", async () => {
    const retryPreview = {
      ...preview,
      progress: [{ ...alpha, state: "imported" }, { ...beta, state: "held", message: "Destination already exists" }],
      counts: { imported: 1, held: 1, failed: 0, remaining: 1 },
    };
    const fetchMock = await openReview(retryPreview);
    expect(document.body.textContent).toContain("Destination already exists");
    expect(document.querySelector('[role="status"]')?.textContent).toContain("1 Needs review");
    fetchMock.mockResolvedValueOnce(response({ operationId: "op" }, 202))
      .mockResolvedValueOnce(response({ state: "complete", preview: {
      ...retryPreview,
      progress: [{ ...alpha, state: "imported" }, { ...beta, state: "imported" }],
      counts: { imported: 2, held: 0, failed: 0, remaining: 0 },
    } }));
    await click(button("Retry Beta"));
    const [, request] = fetchMock.mock.calls.find(([, request]) => request?.method === "POST")!;
    expect(JSON.parse(String(request?.body))).toEqual({
      fingerprint: "revision-1",
      groups: [{ title: beta.title, author: beta.author, files: beta.files }],
    });
    expect(document.querySelector('[role="status"]')?.textContent).toContain("2 Imported");
    expect(document.body.textContent).not.toContain("Retry Beta");
  });

  it("requires a fresh approval when the source changes before import", async () => {
    const fetchMock = await openReview();
    await click(checkbox("Select for import", group("Alpha")));
    fetchMock.mockResolvedValueOnce(response({ operationId: "op" }, 202))
      .mockResolvedValueOnce(response("Source changed", 409));
    await click(button("Import selected books (1)"));
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("Source changed");
    expect(document.querySelector("form > fieldset")?.hasAttribute("disabled")).toBe(true);
    fetchMock.mockResolvedValueOnce(response({ ...preview, fingerprint: "revision-2", candidates: [beta] }));
    await click(button("Refresh preview"));
    expect(fetchMock).toHaveBeenLastCalledWith("/api/librarian/collections/collection-a", undefined);
    expect(document.querySelector("legend")?.textContent).toBe("Beta");
    expect(button("Import selected books (0)").disabled).toBe(true);
  });

  it("selects clear matches in one action and leaves possible duplicates unchecked", async () => {
    await openReview({ ...preview, candidates: [
      { ...alpha, ready: true },
      { ...beta, ready: false, duplicate: "A similar edition is in the library" },
    ] });
    await click(button("Select clear matches (1)"));
    expect(checkbox("Select for import", group("Alpha")).checked).toBe(true);
    expect(checkbox("Select for import", group("Beta")).checked).toBe(false);
    expect(document.body.textContent).toContain("Possible duplicate");
    expect(button("Import selected books (1)").disabled).toBe(false);
  });
  it("uses fresh duplicate and readiness evidence when the source has not changed", async () => {
    const fetchMock = await openReview({ ...preview, candidates: [{ ...alpha, ready: true }, beta] });
    expect(button("Select clear matches (1)").disabled).toBe(false);
    fetchMock.mockResolvedValueOnce(response({ ...preview, candidates: [
      { ...alpha, ready: false, duplicate: "Already in Audiobookshelf" },
      { ...beta, ready: true },
    ] }));
    await click(button("Refresh preview"));
    await click(button("Select clear matches (1)"));
    expect(checkbox("Select for import", group("Alpha")).checked).toBe(false);
    expect(checkbox("Select for import", group("Beta")).checked).toBe(true);
    expect(document.body.textContent).toContain("Already in Audiobookshelf");
  });

  it("requests a fresh server comparison in one step for clear matches", async () => {
    const append = await openReview({ ...preview, candidates: [{ ...alpha, ready: true }, beta] });
    append.mockResolvedValueOnce(response({ operationId: "clear-op" }, 202))
      .mockResolvedValueOnce(response({ state: "complete", preview: {
        ...preview, progress: [{ ...alpha, state: "imported" }],
        counts: { imported: 1, held: 0, failed: 0, remaining: 1 },
      } }));
    await click(button("Import clear matches (1)"));
    expect(append).toHaveBeenCalledWith("/api/librarian/collections/collection-a", expect.objectContaining({
      method: "POST", body: JSON.stringify({ fingerprint: preview.fingerprint, mode: "clear", candidateIds: ["a"] }),
    }));
    expect(document.body.textContent).toContain("kept the originals in the inbox");
  });

});
