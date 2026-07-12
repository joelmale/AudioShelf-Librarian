import type {
  PublicSettingsResponse,
  PublicSystemSettings,
  SettingsHistoryEntry,
  SystemSettings,
} from "@audioshelf/shared";
import {
  AlertTriangle,
  Brain,
  Check,
  Clock3,
  Database,
  Download,
  Folder,
  Gauge,
  KeyRound,
  LoaderCircle,
  RotateCcw,
  Server,
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

interface PreviewSettingsDialogProps {
  open: boolean;
  onClose: () => void;
}

type SecretField = SettingsSecretKey;
type SecretDrafts = SettingsSecretDrafts;

const SECRET_STATUS: Record<SecretField, keyof PublicSettingsResponse["secretStatus"]> = {
  absToken: "absTokenConfigured",
  qbitPass: "qbitPassConfigured",
  anthropicApiKey: "anthropicApiKeyConfigured",
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
  const [connectionTest, setConnectionTest] = React.useState<string | null>(null);
  const dialogRef = React.useRef<HTMLElement>(null);
  const closeRef = React.useRef<HTMLButtonElement>(null);
  const secretDraftsRef = React.useRef<SecretDrafts>({});
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
    secretDraftsRef.current = {};
    setSecretDrafts({});
    Promise.allSettled([loadSettings(), loadSettingsHistory()]).then(([settingsResult, historyResult]) => {
      if (!current) return;
      if (settingsResult.status === "fulfilled") setSettings(settingsResult.value);
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

  const requestClose = React.useCallback(() => {
    if (mutationInProgressRef.current) return;
    if (autosave.hasFailedChanges()) {
      setSaveState("error");
      setSaveError("Retry the unsaved changes before closing settings.");
      return;
    }
    const secretPatch: Partial<SystemSettings> = {};
    for (const field of Object.keys(SECRET_STATUS) as SecretField[]) {
      const value = secretDraftsRef.current[field];
      if (value?.length) secretPatch[field] = value;
    }
    if (Object.keys(secretPatch).length > 0) autosave.schedule(secretPatch, true);
    void autosave.flush()
      .then(() => {
        if (!autosave.hasFailedChanges()) onClose();
      })
      .catch(() => undefined);
  }, [autosave, onClose]);

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
      secretDraftsRef.current = {};
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
            <p id="v2-settings-description">Edits are stored as you type. Running jobs keep the configuration they started with.</p>
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
            <fieldset className="v2-settings-content" disabled={restoring || clearingSecret !== null}>
              <div className="v2-settings-summary">
                <span><span className={`v2-dot ${health.data?.absConnected ? "ok" : health.isLoading ? "" : "warn"}`} /> Audiobookshelf {health.isLoading ? "checking" : health.data?.absConnected ? "connected" : "needs attention"}</span>
                <span><Clock3 /> {history.length} of 100 revisions retained</span>
              </div>

              <details className="v2-settings-group" open>
                <summary><span><Folder /> Library</span><small>Paths & diagnostics</small></summary>
                <div className="v2-settings-grid">
                  <Field label="Library directory" hint="Canonical audiobook library root.">
                    <input value={settings.libraryDir} spellCheck={false} onChange={(event) => setOrdinary("libraryDir", event.target.value)} onBlur={() => void autosave.flush().catch(() => undefined)} />
                  </Field>
                  <Field label="Inbox directory" hint="New downloads and scan intake.">
                    <input value={settings.inboxDir} spellCheck={false} onChange={(event) => setOrdinary("inboxDir", event.target.value)} onBlur={() => void autosave.flush().catch(() => undefined)} />
                  </Field>
                  <label className="v2-setting-switch">
                    <span><strong>Live debug logs</strong><small>Stream detailed backend events to Activity.</small></span>
                    <input type="checkbox" checked={settings.debugLogs} onChange={(event) => setOrdinary("debugLogs", event.target.checked, true)} />
                  </label>
                </div>
              </details>

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
