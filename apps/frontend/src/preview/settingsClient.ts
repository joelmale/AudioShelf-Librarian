import type {
  PublicSettingsResponse,
  PublicSystemSettings,
  SettingsHistoryEntry,
  SystemSettings,
} from "@audioshelf/shared";

type ApiEnvelope<T> = { success: true; data: T };
type SettingsPatch = Partial<SystemSettings>;
export type SettingsSecretKey = "absToken" | "qbitPass" | "anthropicApiKey" | "proxyUrl";
export type SettingsSecretDrafts = Partial<Record<SettingsSecretKey, string>>;

function allKeysOf<T>() {
  return <Keys extends ReadonlyArray<keyof T>>(
    keys: Exclude<keyof T, Keys[number]> extends never ? Keys : never,
  ) => keys;
}

const PUBLIC_SETTING_KEYS = allKeysOf<PublicSystemSettings>()([
  "libraryDir",
  "inboxDir",
  "absUrl",
  "qbitUrl",
  "qbitUser",
  "ollamaUrl",
  "ollamaModel",
  "llmPriority",
  "recommendationScope",
  "debugLogs",
  "actionLogLevel",
  "useProxy",
  "torrentTrackers",
  "pathMappings",
] as const);

export function reconcileSubmittedSecretDrafts(
  drafts: SettingsSecretDrafts,
  submitted: SettingsPatch,
): SettingsSecretDrafts {
  const next = { ...drafts };
  for (const field of ["absToken", "qbitPass", "anthropicApiKey", "proxyUrl"] as const) {
    if (field in submitted && next[field] === submitted[field]) delete next[field];
  }
  return next;
}

export function getSettingsDiffKeys(
  current: PublicSystemSettings,
  target: PublicSystemSettings,
): string[] {
  return PUBLIC_SETTING_KEYS
    .filter((key) => JSON.stringify(current[key]) !== JSON.stringify(target[key]))
    .sort();
}

async function apiRequest<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: init?.body
      ? { "Content-Type": "application/json", ...init.headers }
      : init?.headers,
  });
  const payload = await response.json().catch(() => ({})) as Partial<ApiEnvelope<T>> & { error?: string };
  if (!response.ok) {
    throw new Error(payload.error || `Settings request failed (${response.status})`);
  }
  return payload.data as T;
}

export function loadSettings(): Promise<PublicSettingsResponse> {
  return apiRequest<PublicSettingsResponse>("/api/system/settings");
}

export function updateSettings(patch: SettingsPatch): Promise<PublicSettingsResponse> {
  return apiRequest<PublicSettingsResponse>("/api/system/settings", {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

export function loadSettingsHistory(): Promise<SettingsHistoryEntry[]> {
  return apiRequest<SettingsHistoryEntry[]>("/api/system/settings/history?limit=100");
}

export function restoreSettings(id: string): Promise<{
  settings: PublicSettingsResponse;
  restoredFrom: string;
  changedKeys: string[];
}> {
  return apiRequest(`/api/system/settings/history/${encodeURIComponent(id)}/restore`, {
    method: "POST",
  });
}

export function clearSettingSecret(key: string): Promise<PublicSettingsResponse> {
  return apiRequest(`/api/system/settings/secrets/${encodeURIComponent(key)}`, {
    method: "DELETE",
  });
}

export type AutosaveState = "idle" | "waiting" | "saving" | "saved" | "error";

interface AutosaveOptions {
  delayMs?: number;
  onStateChange?: (state: AutosaveState, error?: Error) => void;
  onSaved?: (settings: PublicSettingsResponse, patch: SettingsPatch) => void;
}

/**
 * Coalesces rapid edits and serializes writes so an older response can never
 * overtake a newer one. The class is UI-agnostic so its race behavior can be
 * covered without a browser test environment.
 */
export class SettingsAutosaveCoordinator {
  private pending: SettingsPatch = {};
  private failed: SettingsPatch = {};
  private failedError: Error | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private tail: Promise<void> = Promise.resolve();
  private latest: Promise<void> = Promise.resolve();
  private readonly delayMs: number;

  constructor(
    private readonly save: (patch: SettingsPatch) => Promise<PublicSettingsResponse>,
    private readonly options: AutosaveOptions = {},
  ) {
    this.delayMs = options.delayMs ?? 700;
  }

  schedule(patch: SettingsPatch, immediate = false): void {
    this.pending = { ...this.pending, ...patch };
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (immediate) {
      void this.flush().catch(() => undefined);
      return;
    }
    this.options.onStateChange?.("waiting");
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush().catch(() => undefined);
    }, this.delayMs);
  }

  flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const patch = this.pending;
    this.pending = {};
    if (Object.keys(patch).length === 0) return this.latest;

    const operation = this.tail.then(async () => {
      this.options.onStateChange?.("saving");
      try {
        const response = await this.save(patch);
        for (const key of Object.keys(patch) as Array<keyof SystemSettings>) {
          delete this.failed[key];
        }
        this.options.onSaved?.(response, patch);
        if (Object.keys(this.failed).length > 0) {
          this.options.onStateChange?.(
            "error",
            this.failedError ?? new Error("Some settings changes could not be saved."),
          );
        } else {
          this.failedError = undefined;
          this.options.onStateChange?.("saved");
        }
      } catch (error) {
        this.failed = { ...this.failed, ...patch };
        this.failedError = error instanceof Error ? error : new Error(String(error));
        this.options.onStateChange?.(
          "error",
          this.failedError,
        );
        throw error;
      }
    });
    this.latest = operation;
    this.tail = operation.catch(() => undefined);
    return operation;
  }

  retry(): Promise<void> {
    this.pending = { ...this.failed, ...this.pending };
    this.failed = {};
    return this.flush();
  }

  hasFailedChanges(): boolean {
    return Object.keys(this.failed).length > 0;
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }
}
