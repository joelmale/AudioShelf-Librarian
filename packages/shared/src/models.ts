import { z } from "zod";

// Config Validation Schema
export const ConfigSchema = z.object({
  PORT: z.string().default("3050").transform((val) => parseInt(val, 10))
});

export type Config = z.infer<typeof ConfigSchema>;

// System Settings Schema for UI-configurable parameters
export const SystemSettingsSchema = z.object({
  libraryDir: z.string().default("/audiobooks"),
  inboxDir: z.string().default("/inbox"),
  absUrl: z.string().optional(),
  absToken: z.string().optional(),
  qbitUrl: z.string().optional(),
  qbitUser: z.string().optional(),
  qbitPass: z.string().optional(),
  anthropicApiKey: z.string().optional()
});

export type SystemSettings = z.infer<typeof SystemSettingsSchema>;

// Shared API Models
export const ScanProgressSchema = z.object({
  scanned: z.number(),
  total: z.number(),
  currentFile: z.string(),
  status: z.enum(["idle", "scanning", "completed", "error", "cancelled"])
});
export type ScanProgress = z.infer<typeof ScanProgressSchema>;

export const RecommendationSchema = z.object({
  itemId: z.string(),
  title: z.string(),
  author: z.string().optional(),
  reason: z.string()
});
export type Recommendation = z.infer<typeof RecommendationSchema>;

// Librarian Domain Models
export const MetadataSourceSchema = z.enum(["abs_json", "id3_tags", "filename", "manual"]);
export type MetadataSource = z.infer<typeof MetadataSourceSchema>;

export const ActionTypeSchema = z.enum(["move", "rename", "copy", "skip", "error"]);
export type ActionType = z.infer<typeof ActionTypeSchema>;

export type ScanOrder = 
  | "alphabetical" 
  | "reverse" 
  | "random" 
  | "quarters" 
  | "eighths" 
  | "size-asc" 
  | "size-desc" 
  | "recent" 
  | "oldest";

export const BookSchema = z.object({
  title: z.string(),
  authors: z.array(z.string()).default(["Unknown Author"]),
  series: z.string().nullable().optional(),
  series_number: z.number().positive().nullable().optional(),
  narrator: z.string().nullable().optional(),
  publisher: z.string().nullable().optional(),
  published_year: z.number().nullable().optional(),
  isbn: z.string().nullable().optional(),
  language: z.string().nullable().optional(),
  genre: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  duration: z.number().nullable().optional(),
  source_path: z.string(), // Absolute paths
  audio_files: z.array(z.string()).default([]),
  cover_file: z.string().nullable().optional(),
  metadata_source: MetadataSourceSchema.default("filename"),
  confidence_score: z.number().min(0).max(1).default(0),
  abs_item_id: z.string().nullable().optional(),
  abs_library_id: z.string().nullable().optional(),
  is_series: z.boolean().default(false),
  needs_processing: z.boolean().default(true),
});
export type Book = z.infer<typeof BookSchema>;

export const OrganizationActionSchema = z.object({
  book: BookSchema,
  action_type: ActionTypeSchema,
  source_path: z.string(),
  target_path: z.string(),
  reason: z.string(),
  executed: z.boolean().default(false),
  execution_time: z.string().datetime().nullable().optional(),
  success: z.boolean().default(false),
  error_message: z.string().nullable().optional(),
});
export type OrganizationAction = z.infer<typeof OrganizationActionSchema>;

export const ScanResultSchema = z.object({
  scanned_path: z.string(),
  books_found: z.array(BookSchema).default([]),
  actions_proposed: z.array(OrganizationActionSchema).default([]),
  errors: z.array(z.string()).default([]),
  scan_time: z.string().datetime()
});
export type ScanResult = z.infer<typeof ScanResultSchema>;

// Dashboard & Integration Models
export interface ABBSearchResult {
  id: string;
  title: string;
  coverUrl: string;
  category: string;
  size: string;
  seeders: number;
  leechers: number;
  added: string;
  url: string;
}

export interface SystemStats {
  abb: {
    activeDomain: string | null;
    lastScrapeTime: Date | null;
    knownMirrorsCount: number;
  };
  torrents: {
    importedCount: number;
    activeDownloads: number;
    completedDownloads: number;
  };
}
