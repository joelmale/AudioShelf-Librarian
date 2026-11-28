import { useEffect, useRef, useState } from "react";
import { errorMessage } from "@audioshelf/shared";
import { ArrowLeft, RefreshCw } from "lucide-react";

interface CleanupPreview {
  title: string;
  importedBooks: number;
  duplicateBooks: number;
  audioFiles: number;
  otherFiles: number;
  blockers: string[];
  token?: string;
  destination: string;
}

interface ArchiveItem {
  id: string;
  title: string;
  archivedAt: string;
  audioFiles: number;
  otherFiles: number;
}

const archiveUrl = "/api/librarian/inbox/archive";

export async function intakeRequest<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const result = await response.json() as { data?: T; error?: string };
  if (!response.ok || result.data === undefined) {
    throw new Error(result.error || "The intake request failed.");
  }
  return result.data;
}

function fileCounts(audio: number, other: number) {
  return audio + (audio === 1 ? " audio file" : " audio files") + (other ? " · " + other + (other === 1 ? " other file" : " other files") : "");
}

export function IntakeCleanup({ url, onBack, onArchived }: {
  url: string;
  onBack: () => void;
  onArchived: (title: string) => void;
}) {
  const [preview, setPreview] = useState<CleanupPreview | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const operation = useRef<AbortController | null>(null);

  async function perform(token?: string) {
    if (operation.current) return;
    const current = new AbortController();
    operation.current = current;
    setBusy(true);
    setError("");
    try {
      if (token) {
        const archived = await intakeRequest<ArchiveItem>(url, {
          method: "POST",
          signal: current.signal,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token }),
        });
        if (!current.signal.aborted) onArchived(archived.title);
      } else {
        const data = await intakeRequest<CleanupPreview>(url, { signal: current.signal });
        if (!current.signal.aborted) setPreview(data);
      }
    } catch (cause) {
      if (!current.signal.aborted) {
        setError(errorMessage(cause));
        setPreview(existing => existing ? { ...existing, token: undefined } : existing);
      }
    } finally {
      if (operation.current === current) {
        operation.current = null;
        setBusy(false);
      }
    }
  }

  useEffect(() => {
    const current = new AbortController();
    operation.current = current;
    setBusy(true);
    void intakeRequest<CleanupPreview>(url, { signal: current.signal }).then(
      data => { if (!current.signal.aborted) setPreview(data); },
      cause => { if (!current.signal.aborted) setError(errorMessage(cause)); },
    ).finally(() => {
      if (operation.current === current) {
        operation.current = null;
        setBusy(false);
      }
    });
    return () => { operation.current?.abort(); operation.current = null; };
  }, [url]);

  return <section className="intake-review" aria-labelledby="intake-cleanup-heading">
    <button type="button" className="v2-button-secondary intake-back" disabled={busy && !!preview} onClick={onBack}><ArrowLeft size={16} /> Back to book review</button>
    <header className="intake-section-head">
      <div><h2 id="intake-cleanup-heading">Cleanup preview</h2>{preview && <p>{preview.title}</p>}</div>
      <button type="button" className="v2-button-secondary" disabled={busy} onClick={() => void perform()}><RefreshCw size={15} /> Recheck cleanup</button>
    </header>
    {busy && <p role="status" className="intake-notice">Checking the inbox source and library copies…</p>}
    {error && <p role="alert" className="intake-notice intake-notice-warning">{error}</p>}
    {preview && <div className="intake-cleanup-grid">
      <section className="intake-cleanup-card">
        <h3>Proposed archive</h3>
        <p className="intake-muted">{fileCounts(preview.audioFiles, preview.otherFiles)}</p>
        <dl className="intake-cleanup-counts">
          <div><dt>Previously imported originals</dt><dd>{preview.importedBooks}</dd></div>
          <div><dt>Confirmed duplicates</dt><dd>{preview.duplicateBooks}</dd></div>
        </dl>
        {preview.destination && <p className="intake-muted">Destination <code>{preview.destination}</code></p>}
        <p className="intake-muted">Archived files no longer appear in the inbox queue and still use disk space. Restore them from Archive history.</p>
      </section>
      <section className="intake-cleanup-card">
        <h3>Before moving files</h3>
        {preview.blockers.length > 0
          ? <ul className="intake-notice-warning">{preview.blockers.map((blocker, index) => <li key={index}>{blocker}</li>)}</ul>
          : <p className="intake-muted">{preview.token ? "The source is ready to archive." : "Recheck cleanup for a fresh preview."}</p>}
        <button type="button" className="glass-button intake-archive-action" disabled={busy || !preview.token || preview.blockers.length > 0}
          onClick={() => void perform(preview.token)}>Move to archive</button>
      </section>
    </div>}
  </section>;
}

export function IntakeArchiveHistory({ onBack, initialNotice }: { onBack: () => void; initialNotice: string }) {
  const [history, setHistory] = useState<ArchiveItem[] | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState(initialNotice);
  const restoring = useRef(false);

  useEffect(() => {
    const current = new AbortController();
    void intakeRequest<ArchiveItem[]>(archiveUrl, { signal: current.signal }).then(
      data => { if (!current.signal.aborted) setHistory(data); },
      cause => { if (!current.signal.aborted) setError(errorMessage(cause)); },
    );
    return () => current.abort();
  }, []);

  async function restore(item: ArchiveItem) {
    if (restoring.current) return;
    restoring.current = true;
    setPending(true);
    setError("");
    setNotice("");
    try {
      await intakeRequest<{ restored: true }>(archiveUrl + "/" + encodeURIComponent(item.id) + "/restore", { method: "POST" });
      setHistory(existing => existing?.filter(record => record.id !== item.id) ?? []);
      setNotice(item.title + " restored to the inbox.");
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setPending(false);
      restoring.current = false;
    }
  }

  return <section className="intake-review" aria-labelledby="intake-archive-heading">
    <button type="button" className="v2-button-secondary intake-back" disabled={pending} onClick={onBack}><ArrowLeft size={16} /> Back to inbox</button>
    <h2 id="intake-archive-heading">Archive history</h2>
    {notice && <p className="intake-notice" role="status">{notice}</p>}
    {error && <p className="intake-notice intake-notice-warning" role="alert">{error}</p>}
    {!history && !error && <p className="intake-muted" role="status">Loading archive history…</p>}
    {history?.length === 0 && <p className="intake-muted">No archived folders.</p>}
    {!!history?.length && <ul className="intake-queue">{history.map(item => <li className="intake-archive-row" key={item.id}>
      <div className="intake-queue-title"><strong>{item.title}</strong><small>{fileCounts(item.audioFiles, item.otherFiles)} · Archived <time dateTime={item.archivedAt}>{new Date(item.archivedAt).toLocaleDateString()}</time></small></div>
      <button type="button" className="v2-button-secondary" disabled={pending} onClick={() => void restore(item)} aria-label={"Restore " + item.title + " to inbox"}>Restore to inbox</button>
    </li>)}</ul>}
  </section>;
}
