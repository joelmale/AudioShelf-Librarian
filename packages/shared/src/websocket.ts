import { z } from "zod";
import { ScanProgressSchema, RecommendationSchema } from "./models.js";

// WebSocket Event Types
export const LibrarianWsMessageSchema = z.object({
  type: z.literal("librarian:scan_progress"),
  payload: ScanProgressSchema
});

export const CuratorWsMessageSchema = z.object({
  type: z.literal("curator:recommendation_ready"),
  payload: RecommendationSchema
});

export const AnyWsMessageSchema = z.discriminatedUnion("type", [
  LibrarianWsMessageSchema,
  CuratorWsMessageSchema
]);

export type AnyWsMessage = z.infer<typeof AnyWsMessageSchema>;
export type LibrarianWsMessage = z.infer<typeof LibrarianWsMessageSchema>;
export type CuratorWsMessage = z.infer<typeof CuratorWsMessageSchema>;
