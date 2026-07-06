import { z } from "zod";
import { ScanProgressSchema, RecommendationSchema, OrganizationActionSchema } from "./models.js";

// WebSocket Event Types
export const LibrarianWsMessageSchema = z.object({
  type: z.literal("librarian:scan_progress"),
  payload: ScanProgressSchema
});

export const LibrarianScanActionMessageSchema = z.object({
  type: z.literal("librarian:scan_action"),
  payload: OrganizationActionSchema
});

export const LibrarianScanWarningMessageSchema = z.object({
  type: z.literal("librarian:scan_warning"),
  payload: z.object({
    message: z.string(),
    files: z.array(z.string())
  })
});

export const CuratorWsMessageSchema = z.object({
  type: z.literal("curator:recommendation_ready"),
  payload: RecommendationSchema
});

export const SystemLogMessageSchema = z.object({
  type: z.literal("system:log"),
  payload: z.object({
    level: z.enum(["info", "warn", "error"]),
    message: z.string(),
    timestamp: z.string()
  })
});

export const AnyWsMessageSchema = z.discriminatedUnion("type", [
  LibrarianWsMessageSchema,
  LibrarianScanActionMessageSchema,
  LibrarianScanWarningMessageSchema,
  CuratorWsMessageSchema,
  SystemLogMessageSchema
]);

export type AnyWsMessage = z.infer<typeof AnyWsMessageSchema>;
export type LibrarianWsMessage = z.infer<typeof LibrarianWsMessageSchema>;
export type LibrarianScanActionMessage = z.infer<typeof LibrarianScanActionMessageSchema>;
export type LibrarianScanWarningMessage = z.infer<typeof LibrarianScanWarningMessageSchema>;
export type CuratorWsMessage = z.infer<typeof CuratorWsMessageSchema>;
