import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { errorMessage } from "@audioshelf/shared";
import { ArrowLeft, BookOpen, CheckCircle2, CircleAlert, Inbox, RefreshCw } from "lucide-react";
import { IntakeArchiveHistory, IntakeCleanup, intakeRequest as collectionRequest } from "./IntakeCleanup.js";
import "./CollectionReviewPanel.css";

interface CollectionSummary {
  id: string;
  title: string;
}

interface BookGroup {
  title: string;
  author: string;
  files: string[];
  importEdition?: boolean;
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
  resolvedDuplicates?: (BookGroup & { id: string })[];
  counts: { imported: number; held: number; failed: number; remaining: number; unassigned?: number };
}

type ImportStatus =
  | { state: "running"; processed: number; total: number }
  | { state: "complete"; preview: CollectionPreview };

interface Draft extends BookGroup {
  id: string;
  suggestion?: Candidate;
  approved: boolean;
  duplicateDecision?: "keep" | "later";
}

const endpoint = "/api/librarian/collections";
const MAX_SELECTED_BOOKS = 100;

function readyForSelection(draft: Draft): boolean {
  return Boolean(draft.suggestion?.ready && !draft.suggestion.duplicate
    && draft.title === draft.suggestion.title && draft.author === draft.suggestion.author);
}

function reservedFiles(preview: CollectionPreview) {
  return new Set([...preview.progress, ...(preview.resolvedDuplicates ?? [])].flatMap(group => group.files));
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

function CollectionReview({ collection, initialPreview, onBack, onArchived, openCleanup }: {
  collection: CollectionSummary;
  initialPreview: CollectionPreview;
  onBack: () => void;
  onArchived: (title: string) => void;
  openCleanup: boolean;
}) {
  const [preview, setPreview] = useState(initialPreview);
  const [drafts, setDrafts] = useState(() => availableDrafts(initialPreview));
  const [unassigned, setUnassigned] = useState(() => availableAudio(initialPreview));
  const [selectedFiles, setSelectedFiles] = useState(() => new Set<string>());
  const [destination, setDestination] = useState("new");
  const [busy, setBusy] = useState(false);
  const [refreshRequired, setRefreshRequired] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [cleanup, setCleanup] = useState(openCleanup);
  const [running, setRunning] = useState<{ processed: number; total: number } | null>(null);
  const nextDraft = useRef(0);
  const requestPending = useRef(false);
  const pendingImport = useRef<AbortController | null>(null);
  useEffect(() => () => pendingImport.current?.abort(), []);
  const url = endpoint + "/" + encodeURIComponent(collection.id);
  const approved = drafts.filter((draft) => draft.approved);
  const duplicateDrafts = drafts.filter(draft => draft.suggestion?.duplicate && draft.title === draft.suggestion.title && draft.author === draft.suggestion.author);
  const duplicateIds = new Set(duplicateDrafts.map(draft => draft.id));
  const decisions = duplicateDrafts.flatMap(draft => draft.duplicateDecision ? [{ id: draft.id, outcome: draft.duplicateDecision }] : []);
  const confirmed = preview.resolvedDuplicates ?? [];
  const readyCount = drafts.filter(readyForSelection).length;
  const reviewCount = drafts.length - readyCount + preview.progress.filter(group => group.state !== "imported").length;

  function updateDraft(id: string, update: Partial<Pick<Draft, "title" | "author" | "approved">>) {
    const editsMetadata = update.title !== undefined || update.author !== undefined;
    setDrafts((current) => current.map((draft) => draft.id === id
      ? { ...draft, ...update, ...(editsMetadata && draft.suggestion?.duplicate
        ? { approved: false, importEdition: undefined, duplicateDecision: undefined }
        : {}) }
      : draft));
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
      return files.length ? [{ ...draft, files, suggestion: undefined, approved: false, importEdition: undefined, duplicateDecision: undefined }] : [];
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

  function applyPreview(next: CollectionPreview, keepEdits: boolean, keepImportSelection = false) {
    setPreview(next);
    if (keepEdits && next.fingerprint === preview.fingerprint) {
      const reserved = reservedFiles(next);
      setDrafts((current) => current.flatMap((draft) => {
        const files = draft.files.filter((file) => !reserved.has(file));
        if (!files.length) return [];
        const fresh = next.candidates.find(candidate => candidate.id === draft.id
          && candidate.files.length === files.length && candidate.files.every((file, index) => file === files[index]));
        const approved = keepImportSelection && draft.approved && (!fresh?.duplicate || Boolean(draft.importEdition));
        return [{ ...draft, files, suggestion: fresh, approved,
          importEdition: approved && fresh?.duplicate && draft.importEdition ? true : undefined, duplicateDecision: undefined }];
      }));
      setUnassigned((current) => current.filter((file) => !reserved.has(file)));
    } else {
      setDrafts(availableDrafts(next));
      setUnassigned(availableAudio(next));
    }
    setSelectedFiles(new Set());
    setDestination("new");
  }

  async function saveDecisions() {
    if (requestPending.current || refreshRequired || !decisions.length) return;
    requestPending.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const next = await collectionRequest<CollectionPreview>(url + "/decisions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ snapshot: preview.fingerprint, decisions }),
      });
      applyPreview(next, true, true);
      const saved = decisions.filter(decision => decision.outcome === "keep").length;
      setNotice(saved ? "Saved " + saved + (saved === 1 ? " duplicate decision." : " duplicate decisions.") : "Deferred books stay in review.");
    } catch (cause) {
      setError(errorMessage(cause));
      setRefreshRequired(true);
    } finally {
      setBusy(false);
      requestPending.current = false;
    }
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
          ...(groups ? { groups: groups.map(({ title, author, files, importEdition }) => ({ title: title.trim(), author: author.trim(), files, ...(importEdition ? { importEdition } : {}) })) } : { mode: "clear", candidateIds: drafts.filter(readyForSelection).slice(0, MAX_SELECTED_BOOKS).map(draft => draft.id) }),
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

  if (cleanup) return <IntakeCleanup url={url + "/cleanup"} onBack={() => setCleanup(false)} onArchived={onArchived} />;

  return <section className="intake-review" aria-label={"Review " + collection.title}>
    <button type="button" className="v2-button-secondary intake-back" onClick={onBack} disabled={busy}><ArrowLeft size={16} /> Back to inbox</button>
    <header className="intake-section-head">
      <div>
        <h2>{collection.title}</h2>
        <p>Review book matches and choose what to add to your library.</p>
      </div>
      <button type="button" className="v2-button-secondary" onClick={() => void refresh()} disabled={busy}><RefreshCw size={15} /> Refresh preview</button>
    </header>

    <div className="intake-summary" role="status">
      <span><strong>{readyCount}</strong> Ready to import</span>
      <span><strong>{reviewCount}</strong> Needs review</span>
      <span><strong>{preview.counts.imported}</strong> Imported</span>
      {confirmed.length > 0 && <span><strong>{confirmed.length}</strong> Duplicates resolved</span>}
      {unassigned.length > 0 && <span><strong>{unassigned.length}</strong> Unassigned files</span>}
    </div>
    {running && <p className="intake-notice" role="status">{running.total ? "Processed " + running.processed + " of " + running.total + (running.total === 1 ? " book" : " books") : "Checking files and library matches…"}</p>}
    {error && <p className="intake-notice intake-notice-warning" role="alert">{error}{refreshRequired && " Refresh the preview to continue."}</p>}
    {notice && <p className="intake-notice" role="status">{notice}</p>}
    {preview.libraryAvailable === false && <p className="intake-notice intake-notice-warning"><CircleAlert size={17} /> Audiobookshelf is unavailable. Automatic selection is paused until the library check succeeds.</p>}
    {preview.warnings.length > 0 && <details className="intake-disclosure"><summary>Scanner notes ({preview.warnings.length})</summary>
      <ul>{preview.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>
    </details>}

    {(preview.counts.imported > 0 || confirmed.length > 0) && <div className="intake-notice intake-review-toolbar">
      <p className="intake-muted">{preview.counts.imported > 0
        ? "AudioShelf created library copies and kept the originals in the inbox."
        : "Source files remain in the inbox."}</p>
      <button type="button" className="v2-button-secondary" disabled={busy || refreshRequired} onClick={() => setCleanup(true)}>Review cleanup</button>
    </div>}
    <form onSubmit={importSelected}>
      <fieldset className="intake-review-form" disabled={busy || refreshRequired}>
        {drafts.length > 0 && <div className="intake-review-toolbar">
          <h3>Books in this collection</h3>
          {readyCount > 0 && <button type="button" className="glass-button" onClick={() => void submit(null)}>Import clear matches ({Math.min(readyCount, MAX_SELECTED_BOOKS)})</button>}
          <button type="button" className="v2-button-secondary" disabled={!readyCount} onClick={() => {
            setDrafts(current => {
              const ids = new Set(current.filter(readyForSelection).slice(0, MAX_SELECTED_BOOKS).map(draft => draft.id));
              return current.map(draft => ({ ...draft, approved: ids.has(draft.id), importEdition: undefined }));
            });
          }}><CheckCircle2 size={16} /> Select clear matches ({Math.min(readyCount, MAX_SELECTED_BOOKS)})</button>
          <button type="submit" className="glass-button" disabled={!approved.length || approved.length > MAX_SELECTED_BOOKS || approved.some(draft => !draft.title.trim() || !draft.author.trim())}>
            {busy ? "Importing…" : "Import selected books (" + approved.length + ")"}
          </button>
          {approved.length > 0 && <button type="button" className="v2-button-secondary"
            onClick={() => setDrafts(current => current.map(draft => ({ ...draft, approved: false, importEdition: undefined })))}>Clear book selection</button>}
        </div>}
        {duplicateDrafts.length > 0 && <div className="intake-review-toolbar intake-duplicate-actions">
          <h3>Possible duplicates ({duplicateDrafts.length})</h3>
          {duplicateDrafts.length > 1 && duplicateDrafts.length <= MAX_SELECTED_BOOKS && <button type="button" className="v2-button-secondary" onClick={() => {
            setDrafts(current => current.map(draft => duplicateIds.has(draft.id)
              ? { ...draft, approved: false, importEdition: undefined, duplicateDecision: "keep" }
              : draft));
          }}>Keep library copies for all {duplicateDrafts.length}</button>}
          <button type="button" className="glass-button" disabled={!decisions.length || decisions.length > MAX_SELECTED_BOOKS} onClick={() => void saveDecisions()}>Save decisions</button>
        </div>}
        {decisions.length > MAX_SELECTED_BOOKS && <p role="status" className="intake-notice-warning">Save up to {MAX_SELECTED_BOOKS} decisions per batch.</p>}
        {approved.length > MAX_SELECTED_BOOKS && <p role="status" className="intake-notice-warning">Select up to {MAX_SELECTED_BOOKS} books per batch.</p>}
        <div className="intake-book-list">
          {[...drafts].sort((a, b) => Number(duplicateIds.has(b.id)) - Number(duplicateIds.has(a.id))
            || Number(readyForSelection(a)) - Number(readyForSelection(b))).map((draft) => {
            const ready = readyForSelection(draft);
            return <fieldset key={draft.id} className="intake-book">
              <legend>{draft.title || "Untitled book"}</legend>
              <div className="intake-book-head">
                {duplicateIds.has(draft.id) ? <label className="intake-book-select">
                  Outcome
                  <select className="glass-input" aria-label={"Decision for " + draft.title} value={draft.approved ? "import" : draft.duplicateDecision ?? ""} onChange={event => {
                    const value = event.target.value;
                    setDrafts(current => current.map(row => row.id === draft.id
                      ? { ...row, approved: value === "import", importEdition: value === "import" ? true : undefined,
                        duplicateDecision: value === "keep" || value === "later" ? value : undefined }
                      : row));
                  }}>
                    <option value="">Choose an outcome</option>
                    <option value="keep">Keep library copy</option>
                    <option value="import">Import this edition</option>
                    <option value="later">Leave for later</option>
                  </select>
                </label> : <label className="intake-book-select">
                  <input type="checkbox" checked={draft.approved} onChange={(event) => updateDraft(draft.id, { approved: event.target.checked })} />
                  <span>Select for import</span>
                </label>}
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
    {preview.progress.some(group => group.state !== "imported") && <section className="intake-results" aria-label="Import results">
      <h3>Import results</h3>
      <ul>
        {preview.progress.filter(group => group.state !== "imported").map(group => <li key={group.id}>
          <div><strong>{group.title}</strong> <span className="intake-status intake-status-review">{group.state}</span>
            {group.message && <p className="intake-muted">{group.message}</p>}
          </div>
          <button type="button" className="v2-button-secondary" disabled={busy || refreshRequired} onClick={() => void submit([{ title: group.title, author: group.author, files: group.files }])}>Retry {group.title}</button>
        </li>)}
      </ul>
    </section>}
    {preview.progress.some(group => group.state === "imported") && <details className="intake-disclosure intake-results">
      <summary>Imported books ({preview.counts.imported})</summary>
      <ul>{preview.progress.filter(group => group.state === "imported").map(group => <li key={group.id}><strong>{group.title}</strong></li>)}</ul>
    </details>}
    {confirmed.length > 0 && <details className="intake-disclosure intake-results">
      <summary>Kept library copies ({confirmed.length})</summary>
      <ul>{confirmed.map(group => <li key={group.id}><strong>{group.title}</strong></li>)}</ul>
    </details>}
    {preview.extras.length > 0 && <details className="intake-disclosure">
      <summary>Unassigned extras ({preview.extras.length})</summary>
      <ul>{preview.extras.map(entry => <li key={entry}>{entry}</li>)}</ul>
    </details>}
  </section>;
}

type InboxStatus = "waiting" | "review" | "importing" | "queued" | "retained" | "other" | "dismissed" | "system";
interface InboxRow {
  name: string;
  title?: string;
  layout?: "single" | "collection" | "unknown";
  kind: "directory" | "file";
  audioFiles?: number;
  otherFiles?: number;
  sourceRelative?: string;
  partial: boolean;
  status: InboxStatus;
  collectionId?: string;
  itemId?: string;
  importedBooks?: number;
  resolvedBooks?: number;
  pendingBooks?: number;
  detail?: string;
}
interface InboxSnapshot { path: string; rows: InboxRow[]; partial: boolean; itemsOnDisk?: number; systemItems?: number }
const statusLabel: Record<InboxStatus, string> = {
  waiting: "Awaiting intake", review: "Needs attention", importing: "Importing", queued: "Queued",
  retained: "Imported · source retained", other: "No audio", dismissed: "Dismissed", system: "System",
};

export function CollectionReviewPanel({ initialCollectionId }: { initialCollectionId?: string } = {}) {
  const [inbox, setInbox] = useState<InboxSnapshot | null>(null);
  const [selected, setSelected] = useState<{ collection: CollectionSummary; preview: CollectionPreview; openCleanup: boolean } | null>(null);
  const [archiveNotice, setArchiveNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const requested = useRef<string | undefined>(undefined);
  const request = useRef<AbortController | null>(null);

  const load = useCallback(async (collection?: CollectionSummary, quiet = false, openCleanup = false) => {
    if (quiet && request.current) return;
    request.current?.abort();
    const current = new AbortController();
    request.current = current;
    setLoading(!quiet);
    if (!quiet) setError("");
    try {
      if (collection) {
        const preview = await collectionRequest<CollectionPreview>(endpoint + "/" + encodeURIComponent(collection.id), { signal: current.signal });
        if (!current.signal.aborted) setSelected({ collection: { ...collection, title: preview.title ?? collection.title }, preview, openCleanup });
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
    if (loading || selected || archiveNotice !== null) return;
    const fast = inbox?.rows.some(row => row.status === "queued" || row.status === "importing");
    const timer = window.setInterval(() => void load(undefined, true), fast ? 4000 : 20000);
    return () => window.clearInterval(timer);
  }, [archiveNotice, inbox, load, loading, selected]);

  useEffect(() => {
    if (!initialCollectionId || !inbox || archiveNotice !== null || requested.current === initialCollectionId) return;
    const row = inbox.rows.find(item => item.collectionId === initialCollectionId);
    if (row?.status === "importing" || row?.status === "queued") return;
    requested.current = initialCollectionId;
    void load({ id: initialCollectionId, title: row?.name ?? "Collection" });
  }, [archiveNotice, inbox, initialCollectionId, load]);

  if (archiveNotice !== null) {
    return <IntakeArchiveHistory initialNotice={archiveNotice}
      onBack={() => { setArchiveNotice(null); void load(); }} />;
  }

  if (selected) {
    return <CollectionReview key={selected.collection.id} collection={selected.collection} initialPreview={selected.preview}
      openCleanup={selected.openCleanup} onBack={() => { setSelected(null); void load(); }}
      onArchived={title => { setSelected(null); setArchiveNotice(title + " moved to the archive."); }} />;
  }

  const visible = inbox?.rows ?? [];
  const attention = visible.filter(row => row.status === "review");
  const processing = visible.filter(row => ["waiting", "queued", "importing"].includes(row.status));
  const retained = visible.filter(row => row.status === "retained");
  const other = visible.filter(row => row.status === "other" || row.status === "dismissed");
  const system = visible.filter(row => row.status === "system");
  const fileCounts = (row: InboxRow) => row.audioFiles === undefined ? row.sourceRelative ?? "Open for file details" :
    (row.partial ? "At least " : "") + row.audioFiles + " audio " + (row.audioFiles === 1 ? "file" : "files")
    + (row.otherFiles ? " · " + row.otherFiles + " other" : "");
  const rows = (entries: InboxRow[]) => <ul className="intake-queue">
    {[...entries].sort((a, b) => a.name.localeCompare(b.name)).map(row => {
      const name = row.title ?? row.name;
      const layout = row.layout === "single" ? "Single book" : row.layout === "collection" ? "Collection" : row.kind === "directory" ? "Folder" : "File";
      const labels = <>
        <span className="intake-queue-icon"><BookOpen size={19} aria-hidden="true" /></span>
        <span className="intake-queue-title"><strong>{name}</strong>
          <small>{layout} · {fileCounts(row)}
            {row.importedBooks ? " · " + row.importedBooks + " imported" : ""}
            {row.resolvedBooks ? " · " + row.resolvedBooks + " duplicates resolved" : ""}
            {row.pendingBooks ? " · " + row.pendingBooks + (row.pendingBooks === 1 ? " decision left" : " decisions left") : ""}</small>
          {row.detail && <small>{row.detail}</small>}
        </span>
        <span className={"intake-status " + (row.status === "retained" ? "intake-status-ready" : "intake-status-review")}>
          {row.status === "retained" && row.collectionId ? "Review cleanup"
            : row.status === "review" && row.collectionId ? "Review books"
              : row.status === "review" && row.itemId ? "Review in Activity" : statusLabel[row.status]}
        </span>
      </>;
      const collectionId = row.collectionId;
      return <li key={row.collectionId ?? row.name}>
        {collectionId && row.status !== "queued" && row.status !== "importing"
          ? <button type="button" className="intake-queue-item" aria-label={(row.status === "retained" ? "Review cleanup for " : "Review ") + name}
            disabled={loading} onClick={() => void load({ id: collectionId, title: name }, false, row.status === "retained")}>{labels}</button>
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
      <div className="intake-inbox-actions">
        <button type="button" className="v2-button-secondary" disabled={loading} onClick={() => void load()}><RefreshCw size={15} /> Refresh inbox</button>
        <button type="button" className="v2-button-secondary" disabled={loading} onClick={() => { request.current?.abort(); setArchiveNotice(""); }}>Archive history</button>
      </div>
    </header>
    {loading && <p className="intake-notice" role="status">Checking inbox…</p>}
    {error && <p className="intake-notice intake-notice-warning" role="alert">{error}</p>}
    {inbox?.partial && <p className="intake-notice intake-notice-warning">Some files or folders could not be counted. Displayed counts may be incomplete.</p>}
    {inbox && <div className="intake-summary" role="status">
      <span><strong>{processing.length}</strong> In queue</span>
      <span><strong>{attention.length}</strong> Need attention</span>
      <span><strong>{retained.length}</strong> Imported sources retained</span>
    </div>}
    {inbox && visible.every(row => row.status === "system") && !loading && <div className="intake-empty">
      <Inbox size={24} aria-hidden="true"/><strong>{inbox.systemItems || system.length ? "No audiobook sources in the inbox" : "The inbox is empty"}</strong>
    </div>}
    {processing.length > 0 && <div className="intake-inbox-section"><h3>In queue</h3>{rows(processing)}</div>}
    {attention.length > 0 && <div className="intake-inbox-section"><h3>Needs attention</h3>{rows(attention)}</div>}
    {retained.length > 0 && <div className="intake-inbox-section">
      <h3>Retained sources</h3>
      {rows(retained)}
    </div>}
    {other.length > 0 && <details className="intake-disclosure"><summary>Other inbox items ({other.length})</summary>{rows(other)}</details>}
    {(inbox?.systemItems || system.length) > 0 && <details className="intake-disclosure">
      <summary>Recovery and system files ({inbox?.systemItems ?? system.length})</summary>
      {system.length ? rows(system) : <p>Recovery and system files stay in place.</p>}
    </details>}
  </section>;
}
