import type {
  LibraryFolderPattern,
  PublicSettingsResponse,
  PublicSystemSettings,
  SettingsHistoryEntry,
  SystemSettings,
} from "@audioshelf/shared";
import { LibraryFolderPatternsSchema } from "@audioshelf/shared";
import {
  AlertTriangle,
  Brain,
  Check,
  Clock3,
  Database,
  Download,
  Folder,
  FolderOpen,
  Gauge,
  KeyRound,
  LoaderCircle,
  RefreshCw,
  RotateCcw,
  Server,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import React from "react";
import { useHealth, useTagStats } from "../../features/curator/api.js";
import {
  clearSettingSecret,
  getSettingsDiffKeys,
  loadSettings,
  loadSettingsHistory,
  reconcileSubmittedSecretDrafts,
  restoreSettings,
  type SettingsSecretDrafts,
  type SettingsSecretKey,
  SettingsAutosaveCoordinator,
  type AutosaveState,
  updateSettings,
} from "../settingsClient.js";
import { withAuthHeaders } from "../../auth/session.js";
import { loadIntegrationStatus, type IntegrationStatus } from "../settingsCapabilities.js";
import { ServerPathPicker } from "./ServerPathPicker.js";

interface PreviewSettingsDialogProps {
  open: boolean;
  onClose: () => void;
}

interface QbitReviewTorrent {
  hash: string;
  name: string;
  progress: number;
  state: string;
  content_path?: string;
  save_path: string;
  size: number;
}

interface QbitReconcileResult {
  hash: string;
  name: string;
  status: "imported" | "conflict" | "unavailable";
  inboxPath?: string;
  reason?: string;
}

type SecretField = SettingsSecretKey;
type SecretDrafts = SettingsSecretDrafts;

const SECRET_STATUS: Record<SecretField, keyof PublicSettingsResponse["secretStatus"]> = {
  absToken: "absTokenConfigured",
  qbitPass: "qbitPassConfigured",
  anthropicApiKey: "anthropicApiKeyConfigured",
  nytApiKey: "nytApiKeyConfigured",
  proxyUrl: "proxyUrlConfigured",
};

const FIELD_LABELS: Record<string, string> = {
  libraryDir: "Library directory",
  inboxDir: "Inbox directory",
  debugLogs: "Live debug logs",
  actionLogLevel: "Action-log verbosity",
  absUrl: "Audiobookshelf URL",
  qbitUrl: "qBittorrent URL",
  qbitUser: "qBittorrent user",
  ollamaUrl: "Ollama URL",
  ollamaModel: "Ollama model",
  llmPriority: "AI provider priority",
  recommendationScope: "Recommendation scope",
  useProxy: "Proxy",
  torrentTrackers: "Torrent trackers",
};

function readableKey(key: string): string {
  return FIELD_LABELS[key] ?? key.replace(/([A-Z])/g, " $1").replace(/^./, (value) => value.toUpperCase());
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="v2-setting-field">
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
}

function SecretInput({
  field,
  label,
  value,
  configured,
  managed,
  confirmClear,
  onChange,
  onCommit,
  onClear,
}: {
  field: SecretField;
  label: string;
  value: string;
  configured: boolean;
  managed: boolean;
  confirmClear: boolean;
  onChange: (value: string) => void;
  onCommit: () => void;
  onClear: () => void;
}) {
  return (
    <div className="v2-setting-field v2-secret-field">
      <div className="v2-setting-label-row">
        <label htmlFor={`v2-${field}`}>{label}</label>
        <span className={configured ? "configured" : "empty"}>
          {managed ? "Environment managed" : configured ? "Configured" : "Not configured"}
        </span>
      </div>
      <div className="v2-secret-control">
        <input
          id={`v2-${field}`}
          type="password"
          value={value}
          disabled={managed}
          autoComplete="new-password"
          spellCheck={false}
          placeholder={configured ? "Enter a replacement" : "Enter credential"}
          onChange={(event) => onChange(event.target.value)}
          onBlur={onCommit}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
          }}
        />
        {configured && !managed && (
          <button
            type="button"
            className={`v2-secret-clear ${confirmClear ? "confirm" : ""}`}
            onClick={onClear}
            aria-label={confirmClear ? `Confirm clearing ${label}` : `Clear ${label}`}
          >
            <Trash2 /> {confirmClear ? "Confirm" : "Clear"}
          </button>
        )}
      </div>
      <small>
        {managed
          ? "Change the container environment to replace this value."
          : "Stored separately; its value is never returned to the browser or revision history."}
      </small>
    </div>
  );
}

export function PreviewSettingsDialog({ open, onClose }: PreviewSettingsDialogProps) {
  const [settings, setSettings] = React.useState<PublicSettingsResponse | null>(null);
  const [history, setHistory] = React.useState<SettingsHistoryEntry[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [historyError, setHistoryError] = React.useState<string | null>(null);
  const [saveState, setSaveState] = React.useState<AutosaveState>("idle");
  const [saveError, setSaveError] = React.useState<string | null>(null);
  const [secretDrafts, setSecretDrafts] = React.useState<SecretDrafts>({});
  const [confirmClear, setConfirmClear] = React.useState<SecretField | null>(null);
  const [restoreCandidate, setRestoreCandidate] = React.useState<SettingsHistoryEntry | null>(null);
  const [restoring, setRestoring] = React.useState(false);
  const [clearingSecret, setClearingSecret] = React.useState<SecretField | null>(null);
  const [testingConnection, setTestingConnection] = React.useState(false);
  const [downloadingDb, setDownloadingDb] = React.useState(false);
  const [dbDownloadNote, setDbDownloadNote] = React.useState<string | null>(null);
  const [connectionTest, setConnectionTest] = React.useState<string | null>(null);
  const [pathPicker, setPathPicker] = React.useState<"libraryDir" | "inboxDir" | null>(null);
  const [folderPatternDrafts, setFolderPatternDrafts] = React.useState<LibraryFolderPattern[]>([]);
  const [folderPatternError, setFolderPatternError] = React.useState<string | null>(null);
  const [savingFolderPatterns, setSavingFolderPatterns] = React.useState(false);
  const [integrationStatus, setIntegrationStatus] = React.useState<IntegrationStatus | null>(null);
  const [integrationError, setIntegrationError] = React.useState<string | null>(null);
  const [loadingIntegrations, setLoadingIntegrations] = React.useState(false);
  const [qbitReviewQueue, setQbitReviewQueue] = React.useState<QbitReviewTorrent[] | null>(null);
  const [qbitSelected, setQbitSelected] = React.useState<Set<string>>(new Set());
  const [qbitReviewResults, setQbitReviewResults] = React.useState<QbitReconcileResult[]>([]);
  const [qbitReviewError, setQbitReviewError] = React.useState<string | null>(null);
  const [loadingQbitReview, setLoadingQbitReview] = React.useState(false);
  const [reconcilingQbit, setReconcilingQbit] = React.useState(false);
  const dialogRef = React.useRef<HTMLElement>(null);
  const closeRef = React.useRef<HTMLButtonElement>(null);
  const secretDraftsRef = React.useRef<SecretDrafts>({});
  const submittedSecretsRef = React.useRef<SecretDrafts>({});
  const mutationInProgressRef = React.useRef(false);
  const health = useHealth();
  const stats = useTagStats();

  const refreshHistory = React.useCallback(async () => {
    try {
      const entries = await loadSettingsHistory();
      setHistory(entries);
      setHistoryError(null);
    } catch (error) {
      setHistoryError(error instanceof Error ? error.message : String(error));
    }
  }, []);

  const savePatch = React.useCallback(async (patch: Partial<SystemSettings>) => {
    const response = await updateSettings(patch);
    setSettings((current) => current ? {
      ...current,
      secretStatus: response.secretStatus,
      managedByEnvironment: response.managedByEnvironment,
    } : response);
    setSecretDrafts((current) => {
      const next = reconcileSubmittedSecretDrafts(current, patch);
      secretDraftsRef.current = next;
      return next;
    });
    for (const field of Object.keys(SECRET_STATUS) as SecretField[]) {
      if (submittedSecretsRef.current[field] === patch[field]) {
        delete submittedSecretsRef.current[field];
      }
    }
    void refreshHistory();
    return response;
  }, [refreshHistory]);

  const autosave = React.useMemo(() => new SettingsAutosaveCoordinator(savePatch, {
    delayMs: 700,
    onStateChange: (state, error) => {
      setSaveState(state);
      setSaveError(error?.message ?? null);
    },
  }), [savePatch]);

  React.useEffect(() => () => {
    void autosave.flush().catch(() => undefined);
    autosave.dispose();
  }, [autosave]);

  React.useEffect(() => {
    if (!open) return;
    let current = true;
    setLoading(true);
    setSettings(null);
    setLoadError(null);
    setConfirmClear(null);
    setRestoreCandidate(null);
    setPathPicker(null);
    setFolderPatternDrafts([]);
    setFolderPatternError(null);
    setIntegrationStatus(null);
    setIntegrationError(null);
    setQbitReviewQueue(null);
    setQbitSelected(new Set());
    setQbitReviewResults([]);
    setQbitReviewError(null);
    secretDraftsRef.current = {};
    submittedSecretsRef.current = {};
    setSecretDrafts({});
    Promise.allSettled([loadSettings(), loadSettingsHistory()]).then(([settingsResult, historyResult]) => {
      if (!current) return;
      if (settingsResult.status === "fulfilled") {
        setSettings(settingsResult.value);
        setFolderPatternDrafts(settingsResult.value.libraryFolderPatterns);
      }
      else setLoadError(settingsResult.reason instanceof Error ? settingsResult.reason.message : String(settingsResult.reason));
      if (historyResult.status === "fulfilled") {
        setHistory(historyResult.value);
        setHistoryError(null);
      } else {
        setHistoryError(historyResult.reason instanceof Error ? historyResult.reason.message : String(historyResult.reason));
      }
      setLoading(false);
    });
    return () => { current = false; };
  }, [open]);

  const queueUnsubmittedSecrets = React.useCallback(() => {
    const secretPatch: Partial<SystemSettings> = {};
    for (const field of Object.keys(SECRET_STATUS) as SecretField[]) {
      const value = secretDraftsRef.current[field];
      if (value?.length && submittedSecretsRef.current[field] !== value) {
        secretPatch[field] = value;
        submittedSecretsRef.current[field] = value;
      }
    }
    if (Object.keys(secretPatch).length > 0) autosave.schedule(secretPatch, true);
  }, [autosave]);

  const flushBeforeLeaving = React.useCallback(async (failureMessage: string) => {
    if (mutationInProgressRef.current) return;
    if (autosave.hasFailedChanges()) {
      setSaveState("error");
      setSaveError(failureMessage);
      return false;
    }
    queueUnsubmittedSecrets();
    try {
      await autosave.flush();
      if (autosave.hasFailedChanges()) {
        setSaveState("error");
        setSaveError(failureMessage);
        return false;
      }
      return true;
    } catch {
      return false;
    }
  }, [autosave, queueUnsubmittedSecrets]);

  const requestClose = React.useCallback(() => {
    void flushBeforeLeaving("Retry the unsaved changes before closing settings.")
      .then((ready) => { if (ready) onClose(); });
  }, [flushBeforeLeaving, onClose]);

  React.useEffect(() => {
    if (!open) return;
    const returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const focusTimer = window.setTimeout(() => closeRef.current?.focus(), 0);

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        requestClose();
        return;
      }
      if (event.key !== "Tab" || !dialogRef.current) return;
      const focusable = Array.from(dialogRef.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])',
      )).filter((element) => element.offsetParent !== null);
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      window.clearTimeout(focusTimer);
      document.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = previousOverflow;
      returnFocus?.focus();
    };
  }, [open, requestClose]);

  const setOrdinary = <K extends keyof PublicSystemSettings>(
    key: K,
    value: PublicSystemSettings[K],
    immediate = false,
  ) => {
    setSettings((current) => current ? { ...current, [key]: value } : current);
    autosave.schedule({ [key]: value } as Partial<SystemSettings>, immediate);
  };

  const commitSecret = (field: SecretField) => {
    const value = secretDraftsRef.current[field];
    if (!value?.length) return;
    submittedSecretsRef.current[field] = value;
    autosave.schedule({ [field]: value }, true);
  };

  const updateSecretDraft = (field: SecretField, value: string) => {
    const next = { ...secretDraftsRef.current, [field]: value };
    secretDraftsRef.current = next;
    setSecretDrafts(next);
    setConfirmClear(null);
  };

  const clearSecret = async (field: SecretField) => {
    if (confirmClear !== field) {
      setConfirmClear(field);
      return;
    }
    mutationInProgressRef.current = true;
    setClearingSecret(field);
    try {
      await autosave.flush();
      if (autosave.hasFailedChanges()) {
        throw new Error("Retry the unsaved changes before clearing a credential.");
      }
      const response = await clearSettingSecret(field);
      setSettings((current) => current ? {
        ...current,
        secretStatus: response.secretStatus,
        managedByEnvironment: response.managedByEnvironment,
      } : response);
      const nextDrafts = { ...secretDraftsRef.current };
      delete nextDrafts[field];
      secretDraftsRef.current = nextDrafts;
      delete submittedSecretsRef.current[field];
      setSecretDrafts(nextDrafts);
      setConfirmClear(null);
      setSaveState("saved");
      setSaveError(null);
    } catch (error) {
      setSaveState("error");
      setSaveError(error instanceof Error ? error.message : String(error));
    } finally {
      mutationInProgressRef.current = false;
      setClearingSecret(null);
    }
  };

  const performRestore = async () => {
    if (!restoreCandidate) return;
    if (autosave.hasFailedChanges()) {
      setSaveState("error");
      setSaveError("Retry the unsaved changes before restoring a revision.");
      return;
    }
    mutationInProgressRef.current = true;
    setRestoring(true);
    try {
      await autosave.flush();
      if (autosave.hasFailedChanges()) {
        throw new Error("Retry the unsaved changes before restoring a revision.");
      }
      const result = await restoreSettings(restoreCandidate.id);
      setSettings(result.settings);
      setFolderPatternDrafts(result.settings.libraryFolderPatterns);
      setFolderPatternError(null);
      secretDraftsRef.current = {};
      submittedSecretsRef.current = {};
      setSecretDrafts({});
      setRestoreCandidate(null);
      setSaveState("saved");
      setSaveError(null);
      await refreshHistory();
    } catch (error) {
      setSaveState("error");
      setSaveError(error instanceof Error ? error.message : String(error));
    } finally {
      mutationInProgressRef.current = false;
      setRestoring(false);
    }
  };

  /**
   * Pull curator.db as a consistent snapshot.
   *
   * Fetched through the auth helper and handed to the browser as a blob
   * rather than being a plain <a href>: an anchor cannot carry the bearer
   * token, so it would 401 on any instance with AUTH_ENABLED=true. The file
   * is ~15-20 MB, small enough to hold in memory for the moment it takes to
   * hand over.
   */
  const downloadDatabase = async () => {
    setDownloadingDb(true);
    setDbDownloadNote(null);
    try {
      const response = await fetch("/api/database/snapshot", { headers: withAuthHeaders() });
      if (!response.ok) throw new Error(`Snapshot failed (${response.status})`);
      const disposition = response.headers.get("content-disposition") ?? "";
      const named = /filename="([^"]+)"/.exec(disposition)?.[1];
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      try {
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = named ?? "curator-snapshot.db";
        anchor.click();
      } finally {
        URL.revokeObjectURL(url);
      }
      setDbDownloadNote(`Downloaded ${(blob.size / 1_048_576).toFixed(1)} MB`);
    } catch (error) {
      setDbDownloadNote(error instanceof Error ? error.message : "Snapshot failed");
    } finally {
      setDownloadingDb(false);
    }
  };

  const testConnection = async () => {
    setTestingConnection(true);
    const startedAt = performance.now();
    try {
      const response = await fetch("/health");
      if (!response.ok) throw new Error(`Health check failed (${response.status})`);
      const result = await response.json() as { absConnected: boolean };
      const elapsed = Math.round(performance.now() - startedAt);
      setConnectionTest(result.absConnected ? `Connected in ${elapsed} ms` : `Not connected (${elapsed} ms)`);
      await health.refetch();
    } catch {
      setConnectionTest("Health check failed");
    } finally {
      setTestingConnection(false);
    }
  };

  const refreshIntegrations = async () => {
    setLoadingIntegrations(true);
    setIntegrationError(null);
    try {
      setIntegrationStatus(await loadIntegrationStatus());
    } catch (error) {
      setIntegrationError(error instanceof Error ? error.message : String(error));
    } finally {
      setLoadingIntegrations(false);
    }
  };

  const loadQbitReview = async () => {
    setLoadingQbitReview(true);
    setQbitReviewError(null);
    setQbitReviewResults([]);
    try {
      await autosave.flush();
      const response = await fetch("/api/librarian/downloads/queue");
      const body = await response.json() as { data?: QbitReviewTorrent[]; error?: string };
      if (!response.ok) throw new Error(body.error || `qBittorrent queue request failed (${response.status})`);
      const completed = (body.data ?? []).filter((torrent) => torrent.progress >= 1);
      setQbitReviewQueue(completed);
      setQbitSelected(new Set(completed.map((torrent) => torrent.hash)));
    } catch (error) {
      setQbitReviewError(error instanceof Error ? error.message : String(error));
    } finally {
      setLoadingQbitReview(false);
    }
  };

  const reconcileQbitSelection = async () => {
    if (qbitSelected.size === 0) return;
    setReconcilingQbit(true);
    setQbitReviewError(null);
    setQbitReviewResults([]);
    try {
      const response = await fetch("/api/librarian/downloads/reconcile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hashes: Array.from(qbitSelected) }),
      });
      const body = await response.json() as { data?: QbitReconcileResult[]; error?: string };
      if (!response.ok) throw new Error(body.error || `Reconciliation failed (${response.status})`);
      setQbitReviewResults(body.data ?? []);
      await refreshIntegrations();
    } catch (error) {
      setQbitReviewError(error instanceof Error ? error.message : String(error));
    } finally {
      setReconcilingQbit(false);
    }
  };

  const toggleQbitSelection = (hash: string) => {
    setQbitSelected((current) => {
      const next = new Set(current);
      if (next.has(hash)) next.delete(hash);
      else next.add(hash);
      return next;
    });
  };

  const updateFolderPattern = <K extends keyof LibraryFolderPattern>(
    index: number,
    key: K,
    value: LibraryFolderPattern[K],
  ) => {
    setFolderPatternDrafts((current) => current.map((pattern, patternIndex) =>
      patternIndex === index ? { ...pattern, [key]: value } : pattern));
    setFolderPatternError(null);
  };

  const saveFolderPatterns = async () => {
    const parsed = LibraryFolderPatternsSchema.safeParse(folderPatternDrafts);
    if (!parsed.success) {
      setFolderPatternError(parsed.error.issues[0]?.message ?? "Folder conventions are invalid.");
      return;
    }
    mutationInProgressRef.current = true;
    setSavingFolderPatterns(true);
    setFolderPatternError(null);
    try {
      await autosave.flush();
      if (autosave.hasFailedChanges()) throw new Error("Retry the unsaved changes before saving folder conventions.");
      const response = await updateSettings({ libraryFolderPatterns: parsed.data });
      setSettings(response);
      setFolderPatternDrafts(response.libraryFolderPatterns);
      setSaveState("saved");
      setSaveError(null);
      await refreshHistory();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setFolderPatternError(message);
      setSaveState("error");
      setSaveError(message);
    } finally {
      mutationInProgressRef.current = false;
      setSavingFolderPatterns(false);
    }
  };

  if (!open) return null;

  const managed = new Set(settings?.managedByEnvironment ?? []);
  const restoreDiffKeys = settings && restoreCandidate
    ? getSettingsDiffKeys(settings, restoreCandidate.snapshot)
    : [];
  const saveLabel = saveState === "saving" || saveState === "waiting"
    ? "Saving…"
    : saveState === "error"
      ? "Couldn’t save"
      : saveState === "saved"
        ? "Saved"
        : "Autosave on";

  return (
    <div className="v2-settings-overlay" onMouseDown={requestClose}>
      <section
        ref={dialogRef}
        className="v2-settings-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="v2-settings-title"
        aria-describedby="v2-settings-description"
        aria-busy={restoring || clearingSecret !== null}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="v2-settings-header">
          <div>
            <span className="v2-eyebrow">Live configuration</span>
            <h2 id="v2-settings-title">Settings</h2>
            <p id="v2-settings-description">Edits are stored as you type except folder conventions, which save only when explicitly confirmed. Running jobs keep the configuration they started with.</p>
          </div>
          <div className="v2-settings-header-actions">
            <span className={`v2-save-state ${saveState}`} role="status" aria-live="polite">
              {saveState === "saving" || saveState === "waiting" ? <LoaderCircle className="spin" /> : saveState === "error" ? <AlertTriangle /> : <Check />}
              {saveLabel}
            </span>
            <button ref={closeRef} type="button" className="v2-icon-button" aria-label="Close settings" disabled={restoring || clearingSecret !== null} onClick={requestClose}><X /></button>
          </div>
        </header>

        {saveError && (
          <div className="v2-settings-error" role="alert">
            <span><AlertTriangle />{saveError}</span>
            {autosave.hasFailedChanges() && <button type="button" onClick={() => void autosave.retry().catch(() => undefined)}>Retry</button>}
          </div>
        )}

        <div className="v2-settings-scroll">
          {loading && !settings ? (
            <div className="v2-settings-loading"><LoaderCircle className="spin" /> Loading settings…</div>
          ) : loadError || !settings ? (
            <div className="v2-settings-empty" role="alert"><AlertTriangle /><p>{loadError || "Settings are unavailable."}</p><button className="v2-button v2-button-secondary" type="button" onClick={requestClose}>Close</button></div>
          ) : (
            <fieldset className="v2-settings-content" disabled={restoring || clearingSecret !== null || savingFolderPatterns}>
              <div className="v2-settings-summary">
                <span><span className={`v2-dot ${health.data?.absConnected ? "ok" : health.isLoading ? "" : "warn"}`} /> Audiobookshelf {health.isLoading ? "checking" : health.data?.absConnected ? "connected" : "needs attention"}</span>
                <span><Clock3 /> {history.length} of 100 revisions retained</span>
              </div>

              <details className="v2-settings-group" open>
                <summary><span><Folder /> Library</span><small>Paths & diagnostics</small></summary>
                <div className="v2-settings-grid">
                  <Field label="Library directory" hint="Canonical audiobook library root.">
                    <div className="v2-path-field-control">
                      <input value={settings.libraryDir} spellCheck={false} onChange={(event) => setOrdinary("libraryDir", event.target.value)} onBlur={() => void autosave.flush().catch(() => undefined)} />
                      <button type="button" onClick={() => setPathPicker("libraryDir")}><FolderOpen /> Browse</button>
                    </div>
                  </Field>
                  <Field label="Inbox directory" hint="New downloads and scan intake.">
                    <div className="v2-path-field-control">
                      <input value={settings.inboxDir} spellCheck={false} onChange={(event) => setOrdinary("inboxDir", event.target.value)} onBlur={() => void autosave.flush().catch(() => undefined)} />
                      <button type="button" onClick={() => setPathPicker("inboxDir")}><FolderOpen /> Browse</button>
                    </div>
                  </Field>
                  <label className="v2-setting-switch">
                    <span><strong>Live debug logs</strong><small>Stream detailed backend events to Activity.</small></span>
                    <input type="checkbox" checked={settings.debugLogs} onChange={(event) => setOrdinary("debugLogs", event.target.checked, true)} />
                  </label>
                  <div className="v2-folder-patterns">
                    <div className="v2-folder-patterns-head">
                      <span><strong>Per-library folder conventions</strong><small>Drafts are saved only when you confirm the complete set below.</small></span>
                      <button type="button" onClick={() => setFolderPatternDrafts((current) => [...current, {
                        libraryId: "",
                        rootDir: "",
                        standalone: "{author}/{title}",
                        series: "{author}/{series}/{series_number} - {title}",
                        source: "configured",
                      }])}>Add convention</button>
                    </div>
                    <p className="v2-settings-note">Supported tokens: <code>{"{author}"}</code>, <code>{"{title}"}</code>, <code>{"{series}"}</code>, <code>{"{series_number}"}</code>, <code>{"{year}"}</code>, and <code>{"{narrator}"}</code>. Literal braces can wrap a token, for example <code>{"{year} - {title} - {{{narrator}}}"}</code>.</p>
                    {folderPatternDrafts.map((pattern, index) => <div className="v2-folder-pattern-row" key={index}>
                      <div className="v2-folder-pattern-row-head"><strong>Convention {index + 1}</strong><span>Source: {pattern.source === "configured" ? "configured" : "detected proposal · not confirmed"}</span>{pattern.source === "detected" && <button type="button" aria-label={`Confirm convention ${index + 1}`} onClick={() => updateFolderPattern(index, "source", "configured")}>Confirm this convention</button>}<button type="button" className="v2-delete-btn" aria-label={`Remove convention ${index + 1}`} onClick={() => setFolderPatternDrafts((current) => current.filter((_, patternIndex) => patternIndex !== index))}><Trash2 size={16} /> Remove</button></div>
                      <div className="v2-settings-grid">
                        <Field label={`Library ID ${index + 1}`} hint="Stable Audiobookshelf library ID."><input aria-label={`Library ID ${index + 1}`} value={pattern.libraryId} onChange={(event) => updateFolderPattern(index, "libraryId", event.target.value)} /></Field>
                        <Field label={`Absolute root ${index + 1}`} hint="The confirmed root for this library."><input aria-label={`Absolute root ${index + 1}`} value={pattern.rootDir} spellCheck={false} placeholder="/audiobooks" onChange={(event) => updateFolderPattern(index, "rootDir", event.target.value)} /></Field>
                        <Field label={`Standalone template ${index + 1}`}><input aria-label={`Standalone template ${index + 1}`} value={pattern.standalone} spellCheck={false} onChange={(event) => updateFolderPattern(index, "standalone", event.target.value)} /></Field>
                        <Field label={`Series template ${index + 1}`}><input aria-label={`Series template ${index + 1}`} value={pattern.series} spellCheck={false} onChange={(event) => updateFolderPattern(index, "series", event.target.value)} /></Field>
                      </div>
                    </div>)}
                    {folderPatternDrafts.length === 0 && <p className="v2-muted">No confirmed conventions. Structure remains Unknown until each observed library is configured.</p>}
                    {folderPatternError && <p className="v2-integration-error" role="alert">{folderPatternError}</p>}
                    <div className="v2-folder-pattern-actions"><button type="button" className="v2-button v2-button-secondary" disabled={savingFolderPatterns} onClick={() => {
                      setFolderPatternDrafts(settings.libraryFolderPatterns);
                      setFolderPatternError(null);
                    }}>Discard convention edits</button><button type="button" className="v2-button v2-success" disabled={savingFolderPatterns} onClick={() => void saveFolderPatterns()}>{savingFolderPatterns ? <LoaderCircle className="spin" /> : <Check />} Save conventions</button></div>
                  </div>
                </div>
              </details>
              {pathPicker && <ServerPathPicker
                initialPath={settings[pathPicker] || "/"}
                label={pathPicker === "libraryDir" ? "Library directory" : "Inbox directory"}
                onCancel={() => setPathPicker(null)}
                onSelect={(selectedPath) => {
                  setOrdinary(pathPicker, selectedPath, true);
                  setPathPicker(null);
                }}
              />}

              <details className="v2-settings-group">
                <summary><span><Server /> Audiobookshelf</span><small>Sidecar connection</small></summary>
                <div className="v2-settings-grid">
                  <Field label="Server URL" hint="Used by new sidecar operations.">
                    <input type="url" value={settings.absUrl ?? ""} placeholder="http://audiobookshelf:80" onChange={(event) => setOrdinary("absUrl", event.target.value)} onBlur={() => void autosave.flush().catch(() => undefined)} />
                  </Field>
                  <SecretInput
                    field="absToken"
                    label="API token"
                    value={secretDrafts.absToken ?? ""}
                    configured={settings.secretStatus.absTokenConfigured}
                    managed={managed.has("absToken")}
                    confirmClear={confirmClear === "absToken"}
                    onChange={(value) => updateSecretDraft("absToken", value)}
                    onCommit={() => commitSecret("absToken")}
                    onClear={() => void clearSecret("absToken")}
                  />
                </div>
              </details>

              <details className="v2-settings-group">
                <summary><span><Download /> Downloads</span><small>qBittorrent & network</small></summary>
                <div className="v2-settings-grid">
                  <Field label="qBittorrent URL">
                    <input type="url" value={settings.qbitUrl ?? ""} placeholder="http://qbittorrent:8080" onChange={(event) => setOrdinary("qbitUrl", event.target.value)} onBlur={() => void autosave.flush().catch(() => undefined)} />
                  </Field>
                  <Field label="Username">
                    <input value={settings.qbitUser ?? ""} autoComplete="username" onChange={(event) => setOrdinary("qbitUser", event.target.value)} onBlur={() => void autosave.flush().catch(() => undefined)} />
                  </Field>
                  <SecretInput
                    field="qbitPass"
                    label="Password"
                    value={secretDrafts.qbitPass ?? ""}
                    configured={settings.secretStatus.qbitPassConfigured}
                    managed={managed.has("qbitPass")}
                    confirmClear={confirmClear === "qbitPass"}
                    onChange={(value) => updateSecretDraft("qbitPass", value)}
                    onCommit={() => commitSecret("qbitPass")}
                    onClear={() => void clearSecret("qbitPass")}
                  />
                  <label className="v2-setting-switch">
                    <span><strong>Use proxy</strong><small>Route discovery requests through the configured proxy.</small></span>
                    <input type="checkbox" checked={settings.useProxy} onChange={(event) => setOrdinary("useProxy", event.target.checked, true)} />
                  </label>
                  {settings.useProxy && <SecretInput
                    field="proxyUrl"
                    label="Proxy URL"
                    value={secretDrafts.proxyUrl ?? ""}
                    configured={settings.secretStatus.proxyUrlConfigured}
                    managed={managed.has("proxyUrl")}
                    confirmClear={confirmClear === "proxyUrl"}
                    onChange={(value) => updateSecretDraft("proxyUrl", value)}
                    onCommit={() => commitSecret("proxyUrl")}
                    onClear={() => void clearSecret("proxyUrl")}
                  />}
                  <Field label="Torrent trackers" hint="One tracker URL per line.">
                    <textarea rows={4} value={settings.torrentTrackers} spellCheck={false} onChange={(event) => setOrdinary("torrentTrackers", event.target.value)} onBlur={() => void autosave.flush().catch(() => undefined)} />
                  </Field>
                  <div className="v2-qbit-path-mappings">
                    <div className="v2-qbit-path-mappings-head">
                      <span><strong>Remote Path Mappings</strong><small>Translate qBittorrent paths to local paths.</small></span>
                      <button type="button" onClick={() => {
                        const newMappings = [...settings.pathMappings, { remotePath: "", localPath: "" }];
                        setOrdinary("pathMappings", newMappings, true);
                      }}>Add mapping</button>
                    </div>
                    {settings.pathMappings?.map((mapping, index) => (
                      <div key={index} className="v2-path-mapping-row">
                        <input type="text" placeholder="Remote path (e.g., /downloads/)" value={mapping.remotePath} onChange={(e) => {
                          const newMappings = [...settings.pathMappings];
                          newMappings[index].remotePath = e.target.value;
                          setOrdinary("pathMappings", newMappings);
                        }} onBlur={() => void autosave.flush().catch(() => undefined)} />
                        <span>=&gt;</span>
                        <input type="text" placeholder="Local path (e.g., C:\Downloads\)" value={mapping.localPath} onChange={(e) => {
                          const newMappings = [...settings.pathMappings];
                          newMappings[index].localPath = e.target.value;
                          setOrdinary("pathMappings", newMappings);
                        }} onBlur={() => void autosave.flush().catch(() => undefined)} />
                        <button type="button" className="v2-delete-btn" onClick={() => {
                          const newMappings = [...settings.pathMappings];
                          newMappings.splice(index, 1);
                          setOrdinary("pathMappings", newMappings, true);
                        }}><Trash2 size={16} /></button>
                      </div>
                    ))}
                  </div>
                  <div className="v2-qbit-recovery">
                    <div className="v2-qbit-recovery-head">
                      <span><strong>Development recovery</strong><small>Manually inspect completed audiobooks and resume interrupted intake.</small></span>
                      <button type="button" disabled={loadingQbitReview || reconcilingQbit} onClick={() => void loadQbitReview()}>
                        {loadingQbitReview ? <LoaderCircle className="spin" /> : <RefreshCw />} {qbitReviewQueue ? "Refresh queue" : "Review completed"}
                      </button>
                    </div>
                    {qbitReviewError && <p className="v2-qbit-recovery-error" role="alert"><AlertTriangle /> {qbitReviewError}</p>}
                    {qbitReviewQueue && qbitReviewQueue.length === 0 && <p className="v2-qbit-recovery-empty"><Check /> No completed torrents remain in the audiobooks category.</p>}
                    {qbitReviewQueue && qbitReviewQueue.length > 0 && <>
                      <div className="v2-qbit-review-list" aria-label="Completed qBittorrent downloads">
                        {qbitReviewQueue.map((torrent) => {
                          const result = qbitReviewResults.find((entry) => entry.hash === torrent.hash);
                          return <label key={torrent.hash} className="v2-qbit-review-row">
                            <input type="checkbox" checked={qbitSelected.has(torrent.hash)} disabled={reconcilingQbit} onChange={() => toggleQbitSelection(torrent.hash)} />
                            <span><strong>{torrent.name}</strong><small>{torrent.content_path || torrent.save_path} · {torrent.state}</small>{result && <em className={result.status}>{result.status === "imported" ? `Imported to ${result.inboxPath}` : result.reason || result.status}</em>}</span>
                          </label>;
                        })}
                      </div>
                      <div className="v2-qbit-recovery-actions">
                        <button type="button" className="secondary" disabled={reconcilingQbit} onClick={() => setQbitSelected(qbitSelected.size === qbitReviewQueue.length ? new Set() : new Set(qbitReviewQueue.map((torrent) => torrent.hash)))}>{qbitSelected.size === qbitReviewQueue.length ? "Clear all" : "Select all"}</button>
                        <button type="button" disabled={qbitSelected.size === 0 || reconcilingQbit} onClick={() => void reconcileQbitSelection()}>{reconcilingQbit ? <LoaderCircle className="spin" /> : <Download />} Process {qbitSelected.size} selected</button>
                      </div>
                    </>}
                  </div>
                </div>
              </details>

              <details className="v2-settings-group">
                <summary><span><Brain /> Intelligence</span><small>Provider order & models</small></summary>
                <div className="v2-settings-grid">
                  <Field label="Provider priority">
                    <select value={settings.llmPriority} onChange={(event) => setOrdinary("llmPriority", event.target.value as PublicSystemSettings["llmPriority"], true)}>
                      <option value="cloud-first">Cloud first</option>
                      <option value="local-first">Local first</option>
                    </select>
                  </Field>
                  {/* The recommendation-scope control is deliberately gone
                      (surface-unification plan §3.3). It only ever seeded the
                      Scout toggle's initial value, and that toggle was removed
                      because it forced a decision before any result existed —
                      `discover` structurally returned zero shelf results. The
                      shelf is now always searched and always shown first, so
                      leaving the control here would be a dead knob. The
                      setting itself stays in the shared schema and
                      `POST /recommendations` still accepts `scope`, so the MCP
                      surface and any saved client are unaffected. */}
                  <SecretInput
                    field="anthropicApiKey"
                    label="Anthropic API key"
                    value={secretDrafts.anthropicApiKey ?? ""}
                    configured={settings.secretStatus.anthropicApiKeyConfigured}
                    managed={managed.has("anthropicApiKey")}
                    confirmClear={confirmClear === "anthropicApiKey"}
                    onChange={(value) => updateSecretDraft("anthropicApiKey", value)}
                    onCommit={() => commitSecret("anthropicApiKey")}
                    onClear={() => void clearSecret("anthropicApiKey")}
                  />
                  <Field label="Ollama URL" hint={managed.has("ollamaUrl") ? "Managed by OLLAMA_URL." : undefined}>
                    <input type="url" value={settings.ollamaUrl} disabled={managed.has("ollamaUrl")} onChange={(event) => setOrdinary("ollamaUrl", event.target.value)} onBlur={() => void autosave.flush().catch(() => undefined)} />
                  </Field>
                  <Field label="Ollama model" hint={managed.has("ollamaModel") ? "Managed by OLLAMA_MODEL." : undefined}>
                    <input value={settings.ollamaModel} disabled={managed.has("ollamaModel")} onChange={(event) => setOrdinary("ollamaModel", event.target.value)} onBlur={() => void autosave.flush().catch(() => undefined)} />
                  </Field>
                </div>
              </details>

              <details className="v2-settings-group">
                <summary><span><Sparkles /> Discovery</span><small>Scout chart sources</small></summary>
                <div className="v2-settings-grid">
                  <SecretInput
                    field="nytApiKey"
                    label="NYT Books API key"
                    value={secretDrafts.nytApiKey ?? ""}
                    configured={settings.secretStatus.nytApiKeyConfigured}
                    managed={managed.has("nytApiKey")}
                    confirmClear={confirmClear === "nytApiKey"}
                    onChange={(value) => updateSecretDraft("nytApiKey", value)}
                    onCommit={() => commitSecret("nytApiKey")}
                    onClear={() => void clearSecret("nytApiKey")}
                  />
                  <p className="v2-settings-note">
                    Enables the NYT audio fiction and nonfiction bestseller charts in Scout &
                    Acquire. Create a free key at developer.nytimes.com and enable the Books API.
                    Without a key those two charts simply stay empty.
                  </p>
                </div>
              </details>

              <details className="v2-settings-group">
                <summary><span><Gauge /> Diagnostics</span><small>Health & log detail</small></summary>
                <div className="v2-settings-grid">
                  <Field label="Action-log verbosity" hint="Persisted and applied immediately; included in revision history.">
                    <select value={settings.actionLogLevel} onChange={(event) => setOrdinary("actionLogLevel", event.target.value as PublicSystemSettings["actionLogLevel"], true)}>
                      <option value="debug">Debug</option>
                      <option value="info">Info</option>
                      <option value="warn">Warn</option>
                      <option value="error">Error</option>
                    </select>
                  </Field>
                  <div className="v2-runtime-grid" aria-label="Runtime status">
                    <span><small>Version</small><strong>{health.data?.version ?? "—"}</strong></span>
                    <span><small>Database</small><strong>{health.data?.dbWritable ? "Writable" : "Unavailable"}</strong></span>
                    <span><small>Books / tagged</small><strong>{stats.data ? `${stats.data.totalBooks} / ${stats.data.taggedBooks}` : "—"}</strong></span>
                  </div>
                  <div className="v2-test-row">
                    <span><strong>Audiobookshelf connection</strong><small>{connectionTest ?? (health.data?.absConnected ? "Connected" : "Not connected")}</small></span>
                    <button type="button" disabled={testingConnection} onClick={() => void testConnection()}>{testingConnection ? <LoaderCircle className="spin" /> : <Server />} Test</button>
                  </div>
                  <div className="v2-test-row">
                    <span><strong>Database snapshot</strong><small>{dbDownloadNote ?? "Full curator.db — tags, entities, embeddings, feedback. No secrets."}</small></span>
                    <button type="button" disabled={downloadingDb} onClick={() => void downloadDatabase()}>{downloadingDb ? <LoaderCircle className="spin" /> : <Database />} Download</button>
                  </div>
                  <div className="v2-integration-head">
                    <span><strong>Integration diagnostics</strong><small>Queries live status only when requested.</small></span>
                    <button type="button" disabled={loadingIntegrations} onClick={() => void refreshIntegrations()}>{loadingIntegrations ? <LoaderCircle className="spin" /> : <RefreshCw />} {integrationStatus ? "Refresh" : "Load status"}</button>
                  </div>
                  {integrationError && <p className="v2-integration-error" role="alert">{integrationError}</p>}
                  {integrationStatus && <div className="v2-integration-grid" aria-live="polite">
                    <article>
                      <span className={`v2-dot ${integrationStatus.audiobookbay.activeDomain ? "ok" : "warn"}`} />
                      <div><strong>AudiobookBay</strong><small>{integrationStatus.audiobookbay.activeDomain || "Resolving mirror"}</small><p>{integrationStatus.audiobookbay.knownMirrors} mirrors · {integrationStatus.audiobookbay.lastScrapeTime ? `scraped ${new Date(integrationStatus.audiobookbay.lastScrapeTime).toLocaleString()}` : "not scraped yet"}</p></div>
                    </article>
                    <article>
                      <span className={`v2-dot ${integrationStatus.qbittorrent.connected ? "ok" : "warn"}`} />
                      <div><strong>qBittorrent</strong><small>{integrationStatus.qbittorrent.connected ? "Connected" : "Offline"}</small><p>{integrationStatus.qbittorrent.activeDownloads ?? 0} active · {integrationStatus.qbittorrent.completedTorrents} complete · {integrationStatus.qbittorrent.importedTorrents} imported</p></div>
                    </article>
                    <article>
                      <span className={`v2-dot ${integrationStatus.audiobookshelf.connected ? "ok" : "warn"}`} />
                      <div><strong>Audiobookshelf</strong><small>{integrationStatus.audiobookshelf.connected ? "Connected" : "Offline"}</small><p>{integrationStatus.audiobookshelf.libraries} libraries · {integrationStatus.audiobookshelf.books} books</p></div>
                    </article>
                    <article>
                      <span className={`v2-dot ${!integrationStatus.proxy.enabled || integrationStatus.proxy.working ? "ok" : "warn"}`} />
                      <div><strong>Proxy network</strong><small>{!integrationStatus.proxy.enabled ? "Disabled" : integrationStatus.proxy.working ? "Connected" : "Offline"}</small><p>{integrationStatus.proxy.enabled ? [integrationStatus.proxy.ip, integrationStatus.proxy.location].filter(Boolean).join(" · ") || "Address unavailable" : "Direct network access"}</p></div>
                    </article>
                  </div>}
                </div>
              </details>

              <details className="v2-settings-group v2-settings-history">
                <summary><span><Database /> Revision history <b>{history.length}</b></span><small>Last 100 non-secret states</small></summary>
                <div className="v2-history-body">
                  <p className="v2-settings-note"><KeyRound /> Credentials are intentionally excluded. Restoring a revision keeps every currently configured secret.</p>
                  {historyError && <p className="v2-history-error" role="alert">{historyError}</p>}
                  {restoreCandidate && (
                    <div className="v2-restore-confirm" role="alert">
                      <div><AlertTriangle /><span><strong>Restore this state?</strong><small>{restoreDiffKeys.length} current {restoreDiffKeys.length === 1 ? "setting" : "settings"} will be replaced immediately: {restoreDiffKeys.map(readableKey).join(", ") || "none"}. A snapshot of the current state will be created first.</small></span></div>
                      <div className="v2-restore-actions">
                        <button type="button" onClick={() => setRestoreCandidate(null)}>Cancel</button>
                        <button type="button" className="danger" disabled={restoring || restoreDiffKeys.length === 0} onClick={() => void performRestore()}>{restoring ? <LoaderCircle className="spin" /> : <RotateCcw />} {restoreDiffKeys.length === 0 ? "Already current" : "Restore"}</button>
                      </div>
                    </div>
                  )}
                  {!historyError && history.length === 0 && <div className="v2-history-empty"><Clock3 /> Previous states appear after the first settings change.</div>}
                  <div className="v2-history-list">
                    {history.map((entry) => (
                      <article key={entry.id}>
                        <div>
                          <strong>{new Date(entry.createdAt).toLocaleString()}</strong>
                          <small>{entry.source === "rollback" ? "Rollback checkpoint" : "Before autosave"} · {entry.actor}</small>
                          <p>{entry.changedKeys.map(readableKey).join(", ")}</p>
                        </div>
                        <button type="button" disabled={restoring} onClick={() => setRestoreCandidate(entry)}><RotateCcw /> Restore</button>
                      </article>
                    ))}
                  </div>
                </div>
              </details>
            </fieldset>
          )}
        </div>
      </section>
    </div>
  );
}
