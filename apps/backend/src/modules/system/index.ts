import { Router } from "express";
import fs from "fs";
import path from "path";
import { SettingsStore } from "../../config/settings.js";

export function createSystemRouter(): Router {
  const router = Router();
  const settingsStore = SettingsStore.getInstance();

  router.get("/settings", (req, res) => {
    try {
      res.json({ success: true, data: settingsStore.getPublicSettings() });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  router.post("/settings", (req, res) => {
    try {
      const updated = settingsStore.updateSettings(req.body);
      res.json({ success: true, data: updated });
    } catch (e: any) {
      res.status(400).json({ error: e.message });
    }
  });

  router.delete("/settings/secrets/:key", (req, res) => {
    try { settingsStore.clearSecret(req.params.key as any); res.json({ success: true, data: settingsStore.getPublicSettings() }); }
    catch (e: any) { res.status(400).json({ error: e.message }); }
  });

  router.get("/fs", async (req, res) => {
    try {
      const targetPath = (req.query.path as string) || "/";
      const resolvedPath = path.resolve(targetPath);
      
      // Ensure it exists and is a directory
      if (!fs.existsSync(resolvedPath)) {
        return res.status(400).json({ error: "Path does not exist" });
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

      res.json({
        success: true,
        currentPath: resolvedPath,
        parentPath: resolvedPath === '/' ? null : path.dirname(resolvedPath),
        directories
      });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  return router;
}
