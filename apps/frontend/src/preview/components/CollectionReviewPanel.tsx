import { useEffect, useRef, useState, type FormEvent } from "react";
import { errorMessage } from "@audioshelf/shared";

interface CollectionSummary {
  id: string;
  title: string;
}

interface BookGroup {
  title: string;
  author: string;
  files: string[];
}

interface Candidate extends BookGroup {
  id: string;
  extras: string[];
  evidence: string[];
  reviewReason?: string;
  duration?: number;
  duplicate?: string;
}

interface ImportProgress extends BookGroup {
  id: string;
  state: "pending" | "imported" | "held" | "failed";
  message?: string;
}

interface CollectionPreview {
  fingerprint: string;
  candidates: Candidate[];
  unassigned: string[];
  extras: string[];
  warnings: string[];
  progress: ImportProgress[];
  counts: { imported: number; held: number; failed: number; remaining: number; unassigned?: number };
}

type ImportStatus =
  | { state: "running"; processed: number; total: number }
  | { state: "complete"; preview: CollectionPreview };

interface Draft extends BookGroup {
  id: string;
  suggestion?: Candidate;
  approved: boolean;
}

const endpoint = "/api/librarian/collections";

async function collectionRequest<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const result = await response.json() as { data?: T; error?: string };
  if (!response.ok || result.data === undefined) {
    throw new Error(result.error || "The collection request failed.");
  }
  return result.data;
}

function reservedFiles(preview: CollectionPreview) {
  return new Set(preview.progress.flatMap((group) => group.files));
}

function availableDrafts(preview: CollectionPreview): Draft[] {
  const reserved = reservedFiles(preview);
  return preview.candidates.flatMap((candidate) => {
    const files = candidate.files.filter((file) => !reserved.has(file));
    if (!files.length) return [];
    const suggestion = files.length === candidate.files.length ? candidate : undefined;
    return [{ id: candidate.id, title: candidate.title, author: candidate.author, files, suggestion, approved: false }];
  });
}

function availableAudio(preview: CollectionPreview) {
  const reserved = reservedFiles(preview);
  return preview.unassigned.filter((file) => !reserved.has(file));
}

function TrackList({ title, files, selected, onToggle }: {
  title: string;
  files: string[];
  selected: ReadonlySet<string>;
  onToggle: (files: string[], checked: boolean) => void;
}) {
  if (!files.length) return null;
  const allSelected = files.every((file) => selected.has(file));
  return <details>
    <summary>{title} ({files.length})</summary>
    {files.length > 1 && <button type="button" className="v2-button-secondary" onClick={() => onToggle(files, !allSelected)}>{allSelected ? "Clear file selection" : "Select all files"}</button>}
    <ul>
      {files.map((file) => <li key={file} style={{ overflowWrap: "anywhere" }}>
        <label><input type="checkbox" checked={selected.has(file)} onChange={(event) => onToggle([file], event.target.checked)} /> {file}</label>
      </li>)}
    </ul>
  </details>;
}

function CollectionReview({ collection, initialPreview, onBack }: { collection: CollectionSummary; initialPreview: CollectionPreview; onBack: () => void }) {
  const [preview, setPreview] = useState(initialPreview);
  const [drafts, setDrafts] = useState(() => availableDrafts(initialPreview));
  const [unassigned, setUnassigned] = useState(() => availableAudio(initialPreview));
  const [selectedFiles, setSelectedFiles] = useState(() => new Set<string>());
  const [destination, setDestination] = useState("new");
  const [busy, setBusy] = useState(false);
  const [refreshRequired, setRefreshRequired] = useState(false);
  const [error, setError] = useState("");
  const [running, setRunning] = useState<{ processed: number; total: number } | null>(null);
  const nextDraft = useRef(0);
  const requestPending = useRef(false);
  const pendingImport = useRef<AbortController | null>(null);
  useEffect(() => () => pendingImport.current?.abort(), []);
  const url = endpoint + "/" + encodeURIComponent(collection.id);
  const approved = drafts.filter((draft) => draft.approved);

  function updateDraft(id: string, update: Partial<Pick<Draft, "title" | "author" | "approved">>) {
    setDrafts((current) => current.map((draft) => draft.id === id ? { ...draft, ...update } : draft));
  }

  function toggleFiles(files: string[], checked: boolean) {
    setSelectedFiles((current) => {
      const next = new Set(current);
      for (const file of files) {
        if (checked) next.add(file);
        else next.delete(file);
      }
      return next;
    });
  }

  function reassign() {
    const moving = [...drafts.flatMap((draft) => draft.files), ...unassigned].filter((file) => selectedFiles.has(file));
    if (!moving.length) return;
    const target = drafts.find((draft) => draft.id === destination);
    const additions = moving.filter((file) => !target?.files.includes(file));
    const next = drafts.flatMap((draft) => {
      const files = draft === target ? [...draft.files, ...additions] : draft.files.filter((file) => !selectedFiles.has(file));
      if (files.length === draft.files.length) return [draft];
      return files.length ? [{ ...draft, files, suggestion: undefined, approved: false }] : [];
    });
    if (destination === "new") {
      next.push({ id: "draft-" + nextDraft.current++, title: "", author: "", files: moving, approved: false });
    }
    const remaining = unassigned.filter((file) => !selectedFiles.has(file));
    setUnassigned(destination === "unassigned" ? [...remaining, ...moving] : remaining);
    setDrafts(next);
    setSelectedFiles(new Set());
    if (destination === "new" || (target && !next.includes(target))) setDestination("new");
  }

  function applyPreview(next: CollectionPreview, keepEdits: boolean) {
    setPreview(next);
    if (keepEdits && next.fingerprint === preview.fingerprint) {
      const reserved = reservedFiles(next);
      setDrafts((current) => current.flatMap((draft) => {
        const files = draft.files.filter((file) => !reserved.has(file));
        if (!files.length) return [];
        return [{ ...draft, files, suggestion: files.length === draft.files.length ? draft.suggestion : undefined, approved: false }];
      }));
      setUnassigned((current) => current.filter((file) => !reserved.has(file)));
    } else {
      setDrafts(availableDrafts(next));
      setUnassigned(availableAudio(next));
    }
    setSelectedFiles(new Set());
    setDestination("new");
  }

  async function submit(groups: BookGroup[]) {
    if (requestPending.current || refreshRequired) return;
    requestPending.current = true;
    const request = new AbortController();
    pendingImport.current = request;
    setError("");
    setBusy(true);
    setRunning({ processed: 0, total: groups.length });
    try {
      const { operationId } = await collectionRequest<{ operationId: string }>(url, {
        method: "POST",
        signal: request.signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fingerprint: preview.fingerprint,
          groups: groups.map(({ title, author, files }) => ({ title: title.trim(), author: author.trim(), files })),
        }),
      });
      const statusUrl = url + "/imports/" + encodeURIComponent(operationId);
      let status = await collectionRequest<ImportStatus>(statusUrl, { signal: request.signal });
      while (status.state === "running") {
        setRunning(status);
        await new Promise(resolve => window.setTimeout(resolve, 750));
        request.signal.throwIfAborted();
        status = await collectionRequest<ImportStatus>(statusUrl, { signal: request.signal });
      }
      applyPreview(status.preview, true);
    } catch (cause) {
      if (request.signal.aborted) return;
      setError(errorMessage(cause));
      setRefreshRequired(true);
    } finally {
      pendingImport.current = null;
      setRunning(null);
      setBusy(false);
      requestPending.current = false;
    }
  }

  async function refresh() {
    if (requestPending.current) return;
    requestPending.current = true;
    setBusy(true);
    setError("");
    try {
      applyPreview(await collectionRequest<CollectionPreview>(url), true);
      setRefreshRequired(false);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
      requestPending.current = false;
    }
  }

  function importSelected(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!approved.length || approved.some((draft) => !draft.title.trim() || !draft.author.trim())) return;
    void submit(approved);
  }

  return <section aria-label={"Review " + collection.title}>
    <button type="button" className="v2-button-secondary" onClick={onBack} disabled={busy}>Back to collections</button>
    <h3>{collection.title}</h3>
    <p role="status">{preview.counts.imported} imported · {preview.counts.held} held · {preview.counts.failed} failed · {preview.counts.remaining} remaining
      {Boolean(preview.counts.unassigned) && <> · {preview.counts.unassigned} unassigned files</>}</p>
    {running && <p role="status">Processed {running.processed} of {running.total} selected books</p>}
    {error && <p role="alert">{error}</p>}
    {refreshRequired && <button type="button" className="v2-button-secondary" onClick={() => void refresh()} disabled={busy}>Refresh preview</button>}
    {preview.warnings.length > 0 && <ul>{preview.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>}
    {preview.progress.length > 0 && <ul aria-label="Import progress">
      {preview.progress.map((group) => <li key={group.id}>
        <strong>{group.title}</strong> · {group.state}{group.message && <> · {group.message}</>}
        {group.state !== "imported" && <>{" "}
          <button type="button" className="v2-button-secondary" disabled={busy || refreshRequired} onClick={() => void submit([group])}>Retry {group.title}</button>
        </>}
      </li>)}
    </ul>}
    <form onSubmit={importSelected}>
      <fieldset disabled={busy || refreshRequired} style={{ minWidth: 0, border: 0, padding: 0, margin: 0 }}>
        {drafts.map((draft, index) => <fieldset key={draft.id} style={{ minWidth: 0, marginBottom: 12 }}>
          <legend>{draft.title || "Book " + (index + 1)}</legend>
          <label><input type="checkbox" checked={draft.approved} onChange={(event) => updateDraft(draft.id, { approved: event.target.checked })} /> Select for import</label>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, margin: "8px 0" }}>
            <label>Title <input className="glass-input" value={draft.title} onChange={(event) => updateDraft(draft.id, { title: event.target.value })} /></label>
            <label>Author <input className="glass-input" value={draft.author} onChange={(event) => updateDraft(draft.id, { author: event.target.value })} /></label>
          </div>
          {draft.suggestion?.duration !== undefined && <p>{Math.max(1, Math.round(draft.suggestion.duration / 60))} min</p>}
          {draft.suggestion?.reviewReason && <p>{draft.suggestion.reviewReason}</p>}
          {draft.suggestion?.duplicate && <p>{draft.suggestion.duplicate}</p>}
          {!!draft.suggestion?.evidence.length && <ul>{draft.suggestion.evidence.map((entry, evidenceIndex) => <li key={evidenceIndex}>{entry}</li>)}</ul>}
          <TrackList title="Audio files" files={draft.files} selected={selectedFiles} onToggle={toggleFiles} />
          {!!draft.suggestion?.extras.length && <details>
            <summary>Book extras ({draft.suggestion.extras.length})</summary>
            <ul>{draft.suggestion.extras.map((entry) => <li key={entry}>{entry}</li>)}</ul>
          </details>}
        </fieldset>)}
        <TrackList title="Unassigned audio" files={unassigned} selected={selectedFiles} onToggle={toggleFiles} />
        {(drafts.length > 0 || unassigned.length > 0) && <div style={{ display: "flex", gap: 8, flexWrap: "wrap", margin: "12px 0" }}>
          <label>Move files to{" "}
            <select className="glass-input" value={destination} onChange={(event) => setDestination(event.target.value)}>
              <option value="new">New book</option>
              <option value="unassigned">Unassigned audio</option>
              {drafts.map((draft, index) => <option key={draft.id} value={draft.id}>{draft.title || "Book " + (index + 1)}</option>)}
            </select>
          </label>
          <button type="button" className="v2-button-secondary" disabled={!selectedFiles.size} onClick={reassign}>Move selected files ({selectedFiles.size})</button>
        </div>}
        {drafts.length > 0 && <button type="submit" className="glass-button" disabled={!approved.length || approved.some((draft) => !draft.title.trim() || !draft.author.trim())}>
          {busy ? "Importing…" : "Import selected books (" + approved.length + ")"}
        </button>}
      </fieldset>
    </form>
    {preview.extras.length > 0 && <details>
      <summary>Unassigned extras ({preview.extras.length})</summary>
      <ul>{preview.extras.map((entry) => <li key={entry}>{entry}</li>)}</ul>
    </details>}
  </section>;
}

export function CollectionReviewPanel() {
  const [collections, setCollections] = useState<CollectionSummary[] | null>(null);
  const [selected, setSelected] = useState<{ collection: CollectionSummary; preview: CollectionPreview } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const requestPending = useRef(false);

  async function load(collection?: CollectionSummary) {
    if (requestPending.current) return;
    requestPending.current = true;
    setLoading(true);
    setError("");
    try {
      if (collection) {
        const preview = await collectionRequest<CollectionPreview>(endpoint + "/" + encodeURIComponent(collection.id));
        setSelected({ collection, preview });
      } else {
        setCollections(await collectionRequest<CollectionSummary[]>(endpoint));
      }
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      requestPending.current = false;
      setLoading(false);
    }
  }

  return <section className="glass-panel" aria-label="Collection imports">
    {selected
      ? <CollectionReview key={selected.collection.id} collection={selected.collection} initialPreview={selected.preview} onBack={() => setSelected(null)} />
      : <>
        <button type="button" className="v2-button-secondary" disabled={loading} onClick={() => void load()}>{collections ? "Refresh collections" : "Split collection"}</button>
        {loading && <p role="status">Loading collection review…</p>}
        {error && <p role="alert">{error}</p>}
        {collections?.length === 0 && <p>No collections need review.</p>}
        {!!collections?.length && <ul aria-label="Collections available for review">
          {collections.map((collection) => <li key={collection.id}>
            <button type="button" className="v2-button-secondary" disabled={loading} onClick={() => void load(collection)}>{collection.title}</button>
          </li>)}
        </ul>}
      </>}
  </section>;
}
