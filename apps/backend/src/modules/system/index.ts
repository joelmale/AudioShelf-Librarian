import { Router, type Request, type Response } from "express";
import fs from "fs";
import path from "path";
import {
  SettingsHistoryNotFoundError,
  SettingsStore,
} from "../../config/settings.js";
import { requireRole } from "../../security/auth.js";
import { PathSecurityError, assertContainedInAny } from "../../security/paths.js";

/**
 * Mount points the container image creates. Used when no explicit roots are
 * configured, so the picker still works out of the box under docker-compose.
 */
const DEFAULT_BROWSE_ROOTS = ["/audiobooks", "/inbox", "/downloads"];

/**
 * Directories the filesystem browser is permitted to enumerate.
 *
 * Without this the endpoint resolved any caller-supplied path and listed it,
 * which handed anyone who could reach the API a map of the whole container
 * (`/root`, `/app/data`, `/proc`, …) — and auth is off by default. Browsing is
 * a genuine feature of the settings dialog, so it is scoped to the media mounts
 * rather than removed. Override with FS_BROWSE_ROOTS for non-Docker installs.
 */
export function browseRoots(settingsStore: SettingsStore): string[] {
  const configured = (process.env.FS_BROWSE_ROOTS ?? "")
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);

  const settings = settingsStore.getSettings();
  const candidates = configured.length > 0
    ? configured
    : [settings.libraryDir, settings.inboxDir, ...DEFAULT_BROWSE_ROOTS];

  const roots: string[] = [];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const resolved = path.resolve(candidate);
    if (roots.includes(resolved)) continue;
    try {
      if (fs.statSync(resolved).isDirectory()) roots.push(resolved);
    } catch {
      // A root that is not mounted on this host is simply not browsable.
    }
  }
  return roots;
}

export function createSystemRouter(settingsStore = SettingsStore.getInstance()): Router {
  const router = Router();

  const updateSettings = (req: Request, res: Response) => {
    try {
      const updated = settingsStore.updateSettings(req.body, req.principal?.subject ?? "internal");
      res.json({ success: true, data: updated });
    } catch (e: any) {
      res.status(400).json({ error: e.message });
    }
  };

  router.get("/settings", (req, res) => {
    try {
      res.json({ success: true, data: settingsStore.getPublicSettings() });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  router.get("/settings/history", requireRole("administrator"), (req, res) => {
    try {
      const requestedLimit = Number.parseInt(String(req.query.limit ?? "100"), 10);
      const limit = Number.isFinite(requestedLimit) ? requestedLimit : 100;
      res.json({ success: true, data: settingsStore.getHistory(limit) });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  router.post("/settings", updateSettings);
  router.patch("/settings", updateSettings);

  router.post("/settings/history/:id/restore", requireRole("administrator"), (req, res) => {
    try {
      const restored = settingsStore.restoreSettings(
        String(req.params.id),
        req.principal?.subject ?? "internal",
      );
      res.json({ success: true, data: restored });
    } catch (e: any) {
      const status = e instanceof SettingsHistoryNotFoundError ? 404 : 400;
      res.status(status).json({ error: e.message });
    }
  });

  router.delete("/settings/secrets/:key", (req, res) => {
    try { settingsStore.clearSecret(req.params.key as any); res.json({ success: true, data: settingsStore.getPublicSettings() }); }
    catch (e: any) { res.status(400).json({ error: e.message }); }
  });

  router.get("/fs", async (req, res) => {
    try {
      const roots = browseRoots(settingsStore);
      if (roots.length === 0) {
        return res.status(400).json({ error: "No browsable directories are configured or mounted" });
      }

      const requested = typeof req.query.path === "string" ? req.query.path.trim() : "";

      // "/" is the picker's default starting point and is not itself browsable.
      // Answer it with the roots so the user has somewhere to go.
      if (!requested || requested === "/") {
        return res.json({
          success: true,
          currentPath: "/",
          parentPath: null,
          directories: roots,
        });
      }

      let resolvedPath: string;
      try {
        resolvedPath = await assertContainedInAny(path.resolve(requested), roots, {
          allowRoot: true,
          mustExist: true,
        });
      } catch (containment) {
        if (containment instanceof PathSecurityError) {
          return res.status(403).json({ error: "Path is outside the browsable directories" });
        }
        throw containment;
      }

      const stat = await fs.promises.stat(resolvedPath);
      if (!stat.isDirectory()) {
        return res.status(400).json({ error: "Path is not a directory" });
      }

      const entries = await fs.promises.readdir(resolvedPath, { withFileTypes: true });
      const directories = entries
        .filter(entry => entry.isDirectory() && !entry.name.startsWith('.')) // hide hidden folders
        .map(entry => entry.name)
        .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));

      // Never offer a parent that would climb out of the browsable roots.
      const isRoot = roots.includes(resolvedPath);

      res.json({
        success: true,
        currentPath: resolvedPath,
        parentPath: isRoot ? "/" : path.dirname(resolvedPath),
        directories
      });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  return router;
}
