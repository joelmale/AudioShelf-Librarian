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

function decision(title: string) {
  const result = group(title).querySelector("select");
  if (!result) throw new Error("Missing outcome for " + title);
  return result;
}

async function choose(title: string, value: string) {
  const select = decision(title);
  await act(async () => { select.value = value; select.dispatchEvent(new Event("change", { bubbles: true })); });
}

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
  it("shows source, import and decision counts and separates system items", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(response({ path: "/inbox", partial: false, itemsOnDisk: 1, systemItems: ["@eaDir", ".DS_Store"], rows: [
      { name: "Pack download", title: "Test collection", collectionId: "collection-a", status: "review", kind: "directory", layout: "collection", audioFiles: 25, otherFiles: 1, importedBooks: 22, pendingAudioFiles: 3, partial: false },
    ] }));
    const element = document.createElement("div");
    document.body.append(element);
    root = createRoot(element);
    await act(async () => root?.render(<CollectionReviewPanel />));
    expect(button("Review Test collection").textContent).toContain("25 audio files · 1 other · 22 imported · 3 unresolved audio files");
    const recovery = [...document.querySelectorAll("details")].find(details => details.textContent?.includes("Recovery and system files (2)"));
    expect(recovery?.open).toBe(false);
    expect(recovery?.textContent).toContain("@eaDir");
    expect(button("Archive history").disabled).toBe(false);
  });

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
    expect(decision("Beta").value).toBe("");
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
    expect(decision("Alpha").value).toBe("");
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

  it("saves confirmed duplicate outcomes as a separate batch and reserves their files", async () => {
    const duplicates = [alpha, beta].map(group => ({ ...group, duplicate: "Library folder match", decisionToken: "evidence-" + group.id }));
    const fetchMock = await openReview({ ...preview, candidates: duplicates });
    expect(button("Save decisions").disabled).toBe(true);
    await click(button("Keep library copies for all 2"));
    expect(decision("Alpha").value).toBe("keep");
    expect(document.body.textContent).not.toContain("Import selected books");
    fetchMock.mockResolvedValueOnce(response({ ...preview, candidates: duplicates, resolvedDuplicates: duplicates }));
    await click(button("Save decisions"));
    expect(fetchMock).toHaveBeenLastCalledWith("/api/librarian/collections/collection-a/decisions", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ snapshot: "revision-1", decisions: [{ id: "a", outcome: "keep", token: "evidence-a" }, { id: "b", outcome: "keep", token: "evidence-b" }] }),
    }));
    expect(document.querySelector("legend")).toBeNull();
    expect(document.body.textContent).toContain("Kept library copies (2)");
    expect(button("Review cleanup").disabled).toBe(false);
    fetchMock.mockResolvedValueOnce(response({ ...preview, candidates: duplicates, resolvedDuplicates: [duplicates[1]] }));
    await click(button("Reopen decision for Alpha"));
    expect(fetchMock).toHaveBeenLastCalledWith("/api/librarian/collections/collection-a/decisions", expect.objectContaining({
      body: JSON.stringify({ snapshot: "revision-1", decisions: [{ id: "a", outcome: "later" }] }),
    }));
    expect(decision("Alpha").value).toBe("");
  });

  it("imports an existing title only through an explicit edition choice", async () => {
    const fetchMock = await openReview({ ...preview, candidates: [alpha, { ...beta, duplicate: "Library folder match" }] });
    await choose("Beta", "import");
    fetchMock.mockResolvedValueOnce(response({ operationId: "op" }, 202))
      .mockResolvedValueOnce(response({ state: "complete", preview }));
    await click(button("Import selected books (1)"));
    expect(fetchMock).toHaveBeenCalledWith("/api/librarian/collections/collection-a", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ fingerprint: preview.fingerprint, groups: [{ title: beta.title, author: beta.author, files: beta.files, importEdition: true }] }),
    }));
  });

  it("requires a fresh preview after a stale archive request and supports restoring the archived source", async () => {
    const imported = {
      ...preview,
      progress: [{ ...alpha, state: "imported" }],
      counts: { imported: 1, held: 0, failed: 0, remaining: 1 },
    };
    const fetchMock = await openReview(imported);
    const cleanupUrl = "/api/librarian/collections/collection-a/cleanup";
    const archiveUrl = "/api/librarian/inbox/archive";
    const plan = { title: "Test collection", importedBooks: 1, duplicateBooks: 1, audioFiles: 3, otherFiles: 1, destination: "/archive/Test collection", blockers: [] };
    const archived = { id: "archive-a", title: plan.title, archivedAt: "2026-11-27T00:00:00Z", expiresAt: "2027-01-26T00:00:00Z", audioFiles: 3, otherFiles: 1 };
    fetchMock.mockResolvedValueOnce(response({ ...plan, blockers: ["Torrent use could not be verified."] }));
    await click(button("Review cleanup"));
    expect(button("Move to archive").disabled).toBe(true);
    expect(document.body.textContent).toContain("Torrent use could not be verified.");
    fetchMock.mockResolvedValueOnce(response({ ...plan, token: "stale" }));
    await click(button("Recheck cleanup"));
    fetchMock.mockResolvedValueOnce(response("The source changed.", 409));
    await click(button("Move to archive"));
    expect(fetchMock).toHaveBeenLastCalledWith(cleanupUrl, expect.objectContaining({ method: "POST", body: '{"token":"stale"}' }));
    expect(button("Move to archive").disabled).toBe(true);
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("The source changed.");
    fetchMock.mockResolvedValueOnce(response({ ...plan, token: "fresh" }));
    await click(button("Recheck cleanup"));
    fetchMock.mockResolvedValueOnce(response(archived)).mockResolvedValueOnce(response([archived]));
    await click(button("Move to archive"));
    expect(document.body.textContent).toContain("Test collection moved to the archive.");
    expect(document.querySelector('time[datetime="2027-01-26T00:00:00Z"]')?.parentElement?.textContent).toContain("Eligible for permanent deletion");
    expect(fetchMock).toHaveBeenLastCalledWith(archiveUrl, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    fetchMock.mockResolvedValueOnce(response("A source already exists at the original path.", 409));
    await click(button("Restore Test collection to inbox"));
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("A source already exists");
    fetchMock.mockResolvedValueOnce(response({ restored: true }));
    await click(button("Restore Test collection to inbox"));
    expect(fetchMock).toHaveBeenLastCalledWith(archiveUrl + "/archive-a/restore", { method: "POST" });
    expect(document.body.textContent).toContain("Test collection restored to the inbox.");
  });

});
