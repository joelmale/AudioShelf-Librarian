import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { errorMessage } from "@audioshelf/shared";
import { ArrowLeft, BookOpen, CheckCircle2, CircleAlert, Inbox, RefreshCw } from "lucide-react";
import "./CollectionReviewPanel.css";

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
  ready?: boolean;
  autoImportEligible?: boolean;
}

interface ImportProgress extends BookGroup {
  id: string;
  state: "pending" | "imported" | "held" | "failed";
  message?: string;
}

interface CollectionPreview {
  title?: string;
  fingerprint: string;
  libraryAvailable?: boolean;
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
const MAX_SELECTED_BOOKS = 100;

function readyForSelection(draft: Draft): boolean {
  return Boolean(draft.suggestion?.ready && draft.title === draft.suggestion.title && draft.author === draft.suggestion.author);
}

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
  const readyCount = drafts.filter(readyForSelection).length;
  const reviewCount = drafts.length - readyCount + preview.progress.filter(group => group.state !== "imported").length;

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
        const fresh = next.candidates.find(candidate => candidate.id === draft.id
          && candidate.files.length === files.length && candidate.files.every((file, index) => file === files[index]));
        return [{ ...draft, files, suggestion: fresh, approved: false }];
      }));
      setUnassigned((current) => current.filter((file) => !reserved.has(file)));
    } else {
      setDrafts(availableDrafts(next));
      setUnassigned(availableAudio(next));
    }
    setSelectedFiles(new Set());
    setDestination("new");
  }

  async function submit(groups: BookGroup[] | null) {
    if (requestPending.current || refreshRequired) return;
    requestPending.current = true;
    const request = new AbortController();
    pendingImport.current = request;
    setError("");
    setBusy(true);
    setRunning({ processed: 0, total: groups?.length ?? 0 });
    try {
      const { operationId } = await collectionRequest<{ operationId: string }>(url, {
        method: "POST",
        signal: request.signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fingerprint: preview.fingerprint,
          ...(groups ? { groups: groups.map(({ title, author, files }) => ({ title: title.trim(), author: author.trim(), files })) } : { mode: "clear", candidateIds: drafts.filter(readyForSelection).slice(0, MAX_SELECTED_BOOKS).map(draft => draft.id) }),
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
    if (!approved.length || approved.length > MAX_SELECTED_BOOKS || approved.some((draft) => !draft.title.trim() || !draft.author.trim())) return;
    void submit(approved);
  }

  return <section className="intake-review" aria-label={"Review " + collection.title}>
    <button type="button" className="v2-button-secondary intake-back" onClick={onBack} disabled={busy}><ArrowLeft size={16} /> All collections</button>
    <header className="intake-section-head">
      <div>
        <h2>{collection.title}</h2>
        <p>Choose the books you want to add to your library.</p>
      </div>
      <button type="button" className="v2-button-secondary" onClick={() => void refresh()} disabled={busy}><RefreshCw size={15} /> Refresh preview</button>
    </header>

    <div className="intake-summary" role="status">
      <span><strong>{readyCount}</strong> Ready to import</span>
      <span><strong>{reviewCount}</strong> Needs review</span>
      <span><strong>{preview.counts.imported}</strong> Imported</span>
      {unassigned.length > 0 && <span><strong>{unassigned.length}</strong> Unassigned files</span>}
    </div>
    {running && <p className="intake-notice" role="status">{running.total ? "Processed " + running.processed + " of " + running.total + (running.total === 1 ? " book" : " books") : "Checking files and library matches…"}</p>}
    {error && <p className="intake-notice intake-notice-warning" role="alert">{error}{refreshRequired && " Refresh the preview to continue."}</p>}
    {preview.libraryAvailable === false && <p className="intake-notice intake-notice-warning"><CircleAlert size={17} /> Audiobookshelf is unavailable. Clear matches will be available after the library check succeeds.</p>}
    {preview.warnings.length > 0 && <details className="intake-disclosure"><summary>Scanner notes ({preview.warnings.length})</summary>
      <ul>{preview.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>
    </details>}

    {preview.counts.imported > 0 && <p className="intake-notice">AudioShelf created library copies and kept the originals in the inbox.</p>}
    <form onSubmit={importSelected}>
      <fieldset className="intake-review-form" disabled={busy || refreshRequired}>
        {drafts.length > 0 && <div className="intake-review-toolbar">
          <h3>Books in this collection</h3>
          {readyCount > 0 && <button type="button" className="glass-button" onClick={() => void submit(null)}>Import clear matches ({Math.min(readyCount, MAX_SELECTED_BOOKS)})</button>}
          <button type="button" className="v2-button-secondary" disabled={!readyCount} onClick={() => {
            setDrafts(current => {
              const ids = new Set(current.filter(readyForSelection).slice(0, MAX_SELECTED_BOOKS).map(draft => draft.id));
              return current.map(draft => ({ ...draft, approved: ids.has(draft.id) }));
            });
          }}><CheckCircle2 size={16} /> Select clear matches ({Math.min(readyCount, MAX_SELECTED_BOOKS)})</button>
          <button type="submit" className="glass-button" disabled={!approved.length || approved.length > MAX_SELECTED_BOOKS || approved.some(draft => !draft.title.trim() || !draft.author.trim())}>
            {busy ? "Importing…" : "Import selected books (" + approved.length + ")"}
          </button>
          {approved.length > 0 && <button type="button" className="v2-button-secondary"
            onClick={() => setDrafts(current => current.map(draft => ({ ...draft, approved: false })))}>Clear book selection</button>}
        </div>}
        {approved.length > MAX_SELECTED_BOOKS && <p role="status" className="intake-notice-warning">Select up to {MAX_SELECTED_BOOKS} books per batch.</p>}
        <div className="intake-book-list">
          {[...drafts].sort((a, b) => Number(readyForSelection(a)) - Number(readyForSelection(b))).map((draft) => {
            const ready = readyForSelection(draft);
            return <fieldset key={draft.id} className="intake-book">
              <legend>{draft.title || "Untitled book"}</legend>
              <div className="intake-book-head">
                <label className="intake-book-select">
                  <input type="checkbox" checked={draft.approved} onChange={(event) => updateDraft(draft.id, { approved: event.target.checked })} />
                  <span>Select for import</span>
                </label>
                <span className={ready ? "intake-status intake-status-ready" : "intake-status intake-status-review"}>{ready ? "Ready" : draft.suggestion?.duplicate ? "Possible duplicate" : "Needs review"}</span>
              </div>
              <p className="intake-muted">{draft.author || "Author missing"} · {draft.files.length} {draft.files.length === 1 ? "file" : "files"}
                {draft.suggestion?.duration !== undefined && <> · {Math.max(1, Math.round(draft.suggestion.duration / 60))} min</>}
              </p>
              {(draft.suggestion?.duplicate || draft.suggestion?.reviewReason || draft.suggestion?.autoImportEligible === false) && <p className="intake-notice-warning">
                {draft.suggestion.duplicate ?? draft.suggestion.reviewReason ?? "Confirm the metadata and that all parts of the book are present."}
              </p>}
              <details className="intake-disclosure">
                <summary>Edit details and files</summary>
                <div className="intake-edit-fields">
                  <label>Title <input className="glass-input" value={draft.title} onChange={(event) => updateDraft(draft.id, { title: event.target.value })} /></label>
                  <label>Author <input className="glass-input" value={draft.author} onChange={(event) => updateDraft(draft.id, { author: event.target.value })} /></label>
                </div>
                {!!draft.suggestion?.evidence.length && <ul>{draft.suggestion.evidence.map((entry, evidenceIndex) => <li key={evidenceIndex}>{entry}</li>)}</ul>}
                <TrackList title="Audio files" files={draft.files} selected={selectedFiles} onToggle={toggleFiles} />
                {!!draft.suggestion?.extras.length && <details className="intake-disclosure">
                  <summary>Book extras ({draft.suggestion.extras.length})</summary>
                  <ul>{draft.suggestion.extras.map((entry) => <li key={entry}>{entry}</li>)}</ul>
                </details>}
              </details>
            </fieldset>;
          })}
        </div>
        {unassigned.length > 0 && <div className="intake-notice">
          <TrackList title="Unassigned audio" files={unassigned} selected={selectedFiles} onToggle={toggleFiles} />
        </div>}
        {selectedFiles.size > 0 && <div className="intake-file-toolbar" role="group" aria-label="Regroup selected files">
          <label>Move files to{" "}
            <select className="glass-input" value={destination} onChange={(event) => setDestination(event.target.value)}>
              <option value="new">New book</option>
              <option value="unassigned">Unassigned audio</option>
              {drafts.map((draft) => <option key={draft.id} value={draft.id}>{draft.title || "Untitled book"}</option>)}
            </select>
          </label>
          <button type="button" className="v2-button-secondary" onClick={reassign}>Move selected files ({selectedFiles.size})</button>
          <button type="button" className="v2-button-secondary" onClick={() => setSelectedFiles(new Set())}>Clear file selection</button>
        </div>}
      </fieldset>
    </form>
    {preview.progress.length > 0 && <section className="intake-results" aria-label="Import results">
      <h3>Import results</h3>
      <ul>
        {preview.progress.map(group => <li key={group.id}>
          <div><strong>{group.title}</strong> <span className={group.state === "imported" ? "intake-status intake-status-ready" : "intake-status intake-status-review"}>{group.state}</span>
            {group.message && <p className="intake-muted">{group.message}</p>}
          </div>
          {group.state !== "imported" && <button type="button" className="v2-button-secondary" disabled={busy || refreshRequired} onClick={() => void submit([group])}>Retry {group.title}</button>}
        </li>)}
      </ul>
    </section>}
    {preview.extras.length > 0 && <details className="intake-disclosure">
      <summary>Unassigned extras ({preview.extras.length})</summary>
      <ul>{preview.extras.map(entry => <li key={entry}>{entry}</li>)}</ul>
    </details>}
  </section>;
}

type InboxStatus = "waiting" | "review" | "importing" | "queued" | "retained" | "other" | "dismissed";
interface InboxRow {
  name: string;
  kind: "directory" | "file";
  audioFiles?: number;
  otherFiles?: number;
  sourceRelative?: string;
  partial: boolean;
  status: InboxStatus;
  collectionId?: string;
  itemId?: string;
  importedBooks?: number;
  detail?: string;
}
interface InboxSnapshot { path: string; rows: InboxRow[]; partial: boolean; itemsOnDisk?: number }
const statusLabel: Record<InboxStatus, string> = {
  waiting: "Awaiting intake", review: "Needs attention", importing: "Importing", queued: "Queued",
  retained: "Imported · source retained", other: "No audio", dismissed: "Dismissed",
};

export function CollectionReviewPanel({ initialCollectionId }: { initialCollectionId?: string } = {}) {
  const [inbox, setInbox] = useState<InboxSnapshot | null>(null);
  const [selected, setSelected] = useState<{ collection: CollectionSummary; preview: CollectionPreview } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const requested = useRef<string | undefined>(undefined);
  const request = useRef<AbortController | null>(null);

  const load = useCallback(async (collection?: CollectionSummary, quiet = false) => {
    if (quiet && request.current) return;
    request.current?.abort();
    const current = new AbortController();
    request.current = current;
    setLoading(!quiet);
    if (!quiet) setError("");
    try {
      if (collection) {
        const preview = await collectionRequest<CollectionPreview>(endpoint + "/" + encodeURIComponent(collection.id), { signal: current.signal });
        if (!current.signal.aborted) setSelected({ collection: { ...collection, title: preview.title ?? collection.title }, preview });
      } else {
        const snapshot = await collectionRequest<InboxSnapshot>("/api/librarian/inbox", { signal: current.signal });
        if (!current.signal.aborted) { setInbox(snapshot); setError(""); }
      }
    } catch (cause) {
      if (!current.signal.aborted) setError(errorMessage(cause));
    } finally {
      if (request.current === current) { request.current = null; setLoading(false); }
    }
  }, []);

  useEffect(() => {
    void load();
    return () => request.current?.abort();
  }, [load]);

  useEffect(() => {
    if (loading || selected) return;
    const fast = inbox?.rows.some(row => row.status === "queued" || row.status === "importing");
    const timer = window.setInterval(() => void load(undefined, true), fast ? 4000 : 20000);
    return () => window.clearInterval(timer);
  }, [inbox, load, loading, selected]);

  useEffect(() => {
    if (!initialCollectionId || !inbox || requested.current === initialCollectionId) return;
    const row = inbox.rows.find(item => item.collectionId === initialCollectionId);
    if (row?.status === "importing" || row?.status === "queued") return;
    requested.current = initialCollectionId;
    void load({ id: initialCollectionId, title: row?.name ?? "Collection" });
  }, [inbox, initialCollectionId, load]);

  if (selected) {
    return <CollectionReview key={selected.collection.id} collection={selected.collection} initialPreview={selected.preview}
      onBack={() => { setSelected(null); void load(); }} />;
  }

  const visible = inbox?.rows ?? [];
  const attention = visible.filter(row => row.status === "review");
  const processing = visible.filter(row => ["waiting", "queued", "importing"].includes(row.status));
  const retained = visible.filter(row => row.status === "retained");
  const other = visible.filter(row => row.status === "other" || row.status === "dismissed");
  const fileCounts = (row: InboxRow) => row.audioFiles === undefined ? row.sourceRelative ?? "Open for file details" :
    (row.partial ? "At least " : "") + row.audioFiles + " audio " + (row.audioFiles === 1 ? "file" : "files")
    + (row.otherFiles ? " · " + row.otherFiles + " other" : "");
  const rows = (entries: InboxRow[]) => <ul className="intake-queue">
    {[...entries].sort((a, b) => a.name.localeCompare(b.name)).map(row => {
      const labels = <>
        <span className="intake-queue-icon"><BookOpen size={19} aria-hidden="true" /></span>
        <span className="intake-queue-title"><strong>{row.name}</strong>
          <small>{row.kind === "directory" ? "Folder" : "File"} · {fileCounts(row)}
            {row.importedBooks ? " · " + row.importedBooks + " books imported" : ""}</small>
          {row.detail && <small>{row.detail}</small>}
        </span>
        <span className={"intake-status " + (row.status === "retained" ? "intake-status-ready" : "intake-status-review")}>{statusLabel[row.status]}</span>
      </>;
      const collectionId = row.collectionId;
      return <li key={row.collectionId ?? row.name}>
        {collectionId && row.status !== "queued" && row.status !== "importing"
          ? <button type="button" className="intake-queue-item" aria-label={(row.status === "retained" ? "View import results for " : "Review ") + row.name}
            disabled={loading} onClick={() => void load({ id: collectionId, title: row.name })}>{labels}</button>
          : row.itemId && row.status === "review"
            ? <Link className="intake-queue-item" to={"/activity/ing_" + encodeURIComponent(row.itemId)}>{labels}</Link>
            : <div className="intake-queue-item intake-queue-static">{labels}</div>}
      </li>;
    })}
  </ul>;
  return <section className="intake-review" aria-labelledby="intake-queue-heading">
    <header className="intake-section-head">
      <div><h2 id="intake-queue-heading">Inbox overview</h2>
        <p>{inbox ? <><code>{inbox.path}</code> · {inbox.itemsOnDisk ?? visible.length} {(inbox.itemsOnDisk ?? visible.length) === 1 ? "item" : "items"} on disk</> : "Checking the inbox and matching files with import records."}</p>
      </div>
      <button type="button" className="v2-button-secondary" disabled={loading} onClick={() => void load()}><RefreshCw size={15} /> Refresh inbox</button>
    </header>
    {loading && <p className="intake-notice" role="status">Checking inbox…</p>}
    {error && <p className="intake-notice intake-notice-warning" role="alert">{error}</p>}
    {inbox?.partial && <p className="intake-notice intake-notice-warning">Some files or folders could not be counted. Displayed counts may be incomplete.</p>}
    {inbox && <div className="intake-summary" role="status">
      <span><strong>{processing.length}</strong> In queue</span>
      <span><strong>{attention.length}</strong> Need attention</span>
      <span><strong>{retained.length}</strong> Imported sources retained</span>
    </div>}
    {inbox && !visible.length && !loading && <div className="intake-empty"><Inbox size={24} aria-hidden="true"/><strong>The inbox is empty</strong></div>}
    {processing.length > 0 && <div className="intake-inbox-section"><h3>In queue</h3>{rows(processing)}</div>}
    {attention.length > 0 && <div className="intake-inbox-section"><h3>Needs attention</h3>{rows(attention)}</div>}
    {retained.length > 0 && <details className="intake-disclosure">
      <summary>Imported sources retained ({retained.length})</summary>
      <p>AudioShelf created library copies and kept these originals in the inbox.</p>
      {rows(retained)}
    </details>}
    {other.length > 0 && <details className="intake-disclosure"><summary>Other inbox items ({other.length})</summary>{rows(other)}</details>}
  </section>;
}
