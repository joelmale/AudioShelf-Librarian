import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PublicSettingsResponse } from "@audioshelf/shared";
import { PublicSystemSettingsSchema } from "@audioshelf/shared";

import {
  getSettingsDiffKeys,
  reconcileSubmittedSecretDrafts,
  SettingsAutosaveCoordinator,
} from "./settingsClient";

const response = {} as PublicSettingsResponse;

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("SettingsAutosaveCoordinator", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("debounces and coalesces rapid field edits into one patch", async () => {
    const save = vi.fn().mockResolvedValue(response);
    const onStateChange = vi.fn();
    const onSaved = vi.fn();
    const coordinator = new SettingsAutosaveCoordinator(save, {
      delayMs: 500,
      onStateChange,
      onSaved,
    });

    coordinator.schedule({ libraryDir: "/library-one" });
    await vi.advanceTimersByTimeAsync(300);
    coordinator.schedule({ inboxDir: "/incoming" });
    await vi.advanceTimersByTimeAsync(499);

    expect(save).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);

    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith({
      libraryDir: "/library-one",
      inboxDir: "/incoming",
    });
    expect(onSaved).toHaveBeenCalledWith(response, {
      libraryDir: "/library-one",
      inboxDir: "/incoming",
    });
    expect(onStateChange.mock.calls.map(([state]) => state)).toEqual([
      "waiting",
      "waiting",
      "saving",
      "saved",
    ]);
  });

  it("flushes all pending edits immediately without a later duplicate save", async () => {
    const save = vi.fn().mockResolvedValue(response);
    const coordinator = new SettingsAutosaveCoordinator(save, { delayMs: 500 });

    coordinator.schedule({ libraryDir: "/library-two" });
    coordinator.schedule({ debugLogs: false }, true);
    await vi.advanceTimersByTimeAsync(0);

    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith({
      libraryDir: "/library-two",
      debugLogs: false,
    });

    await vi.advanceTimersByTimeAsync(1_000);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("serializes writes so a later request cannot start before the first settles", async () => {
    const first = deferred<PublicSettingsResponse>();
    const second = deferred<PublicSettingsResponse>();
    const save = vi
      .fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    const coordinator = new SettingsAutosaveCoordinator(save);

    coordinator.schedule({ libraryDir: "/first" });
    const firstOperation = coordinator.flush();
    coordinator.schedule({ inboxDir: "/second" });
    const secondOperation = coordinator.flush();
    await vi.advanceTimersByTimeAsync(0);

    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenNthCalledWith(1, { libraryDir: "/first" });

    first.resolve(response);
    await firstOperation;
    await vi.advanceTimersByTimeAsync(0);

    expect(save).toHaveBeenCalledTimes(2);
    expect(save).toHaveBeenNthCalledWith(2, { inboxDir: "/second" });

    second.resolve(response);
    await secondOperation;
  });

  it("preserves a failed patch and merges it with pending edits on retry", async () => {
    const failure = new Error("network unavailable");
    const save = vi
      .fn()
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce(response);
    const onStateChange = vi.fn();
    const coordinator = new SettingsAutosaveCoordinator(save, {
      delayMs: 500,
      onStateChange,
    });

    coordinator.schedule({ libraryDir: "/must-survive" });
    await expect(coordinator.flush()).rejects.toThrow("network unavailable");
    expect(coordinator.hasFailedChanges()).toBe(true);

    coordinator.schedule({ inboxDir: "/new-edit" });
    await coordinator.retry();

    expect(save).toHaveBeenCalledTimes(2);
    expect(save).toHaveBeenNthCalledWith(2, {
      libraryDir: "/must-survive",
      inboxDir: "/new-edit",
    });
    expect(coordinator.hasFailedChanges()).toBe(false);
    expect(onStateChange.mock.calls.map(([state]) => state)).toEqual([
      "waiting",
      "saving",
      "error",
      "waiting",
      "saving",
      "saved",
    ]);
  });

  it("propagates an in-flight failure when flush is called with no new patch", async () => {
    const inFlight = deferred<PublicSettingsResponse>();
    const coordinator = new SettingsAutosaveCoordinator(() => inFlight.promise);

    coordinator.schedule({ libraryDir: "/in-flight" }, true);
    await vi.advanceTimersByTimeAsync(0);
    const settle = coordinator.flush();
    inFlight.reject(new Error("write failed"));

    await expect(settle).rejects.toThrow("write failed");
    expect(coordinator.hasFailedChanges()).toBe(true);
  });

  it("keeps the error state when a different later patch succeeds", async () => {
    const onStateChange = vi.fn();
    const save = vi.fn()
      .mockRejectedValueOnce(new Error("library write failed"))
      .mockResolvedValueOnce(response);
    const coordinator = new SettingsAutosaveCoordinator(save, { onStateChange });

    coordinator.schedule({ libraryDir: "/failed" });
    await expect(coordinator.flush()).rejects.toThrow("library write failed");
    coordinator.schedule({ debugLogs: false });
    await coordinator.flush();

    expect(coordinator.hasFailedChanges()).toBe(true);
    expect(onStateChange.mock.calls.at(-1)?.[0]).toBe("error");
    expect(onStateChange.mock.calls.at(-1)?.[1]).toEqual(expect.objectContaining({
      message: "library write failed",
    }));
  });

  it("cancels a scheduled save when disposed", async () => {
    const save = vi.fn().mockResolvedValue(response);
    const coordinator = new SettingsAutosaveCoordinator(save, { delayMs: 500 });

    coordinator.schedule({ libraryDir: "/discarded" });
    coordinator.dispose();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(save).not.toHaveBeenCalled();
  });
});

describe("settings rollback diff", () => {
  it("defaults recommendations to discovering new audiobooks", () => {
    expect(PublicSystemSettingsSchema.parse({}).recommendationScope).toBe("discover");
  });

  it("compares the complete current state with the target snapshot", () => {
    const target = PublicSystemSettingsSchema.parse({});
    const current = PublicSystemSettingsSchema.parse({
      libraryDir: "/changed-library",
      inboxDir: "/changed-inbox",
      debugLogs: false,
    });

    expect(getSettingsDiffKeys(current, target)).toEqual([
      "debugLogs",
      "inboxDir",
      "libraryDir",
    ]);
  });

  it("ignores public-response metadata when the snapshot is already current", () => {
    const target = PublicSystemSettingsSchema.parse({});
    const current: PublicSettingsResponse = {
      ...target,
      secretStatus: {
        absTokenConfigured: true,
        qbitPassConfigured: false,
        anthropicApiKeyConfigured: false,
        proxyUrlConfigured: true,
      },
      managedByEnvironment: ["absToken"],
    };

    expect(getSettingsDiffKeys(current, target)).toEqual([]);
  });
});

describe("secret draft reconciliation", () => {
  it("keeps a newer credential draft when an older request finishes", () => {
    expect(reconcileSubmittedSecretDrafts(
      { absToken: "newer-token", qbitPass: "submitted-password" },
      { absToken: "older-token", qbitPass: "submitted-password" },
    )).toEqual({ absToken: "newer-token" });
  });
});
