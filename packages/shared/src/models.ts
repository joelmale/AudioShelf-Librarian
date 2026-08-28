import { z } from "zod";

// Config Validation Schema
export const ConfigSchema = z.object({
  PORT: z.string().default("3050").transform((val) => parseInt(val, 10))
});

export type Config = z.infer<typeof ConfigSchema>;

// Path Mapping Schema for translating remote qBittorrent paths to local paths
export const PathMappingSchema = z.object({
  remotePath: z.string().min(1),
  localPath: z.string().min(1),
});
export type PathMapping = z.infer<typeof PathMappingSchema>;

export const FolderPatternTokenSchema = z.enum([
  "author",
  "title",
  "series",
  "series_number",
  "year",
  "narrator",
]);
export type FolderPatternToken = z.infer<typeof FolderPatternTokenSchema>;

const FOLDER_PATTERN_TOKENS = new Set<string>(FolderPatternTokenSchema.options);

function hasControlCharacters(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127;
  });
}

/**
 * Folder templates are portable relative paths. A single-braced name is a
 * metadata token; doubled braces emit literal braces. Backslashes are not
 * separators so a saved convention behaves identically on every host OS.
 */
export function folderPatternTemplateIssue(template: string): string | undefined {
  if (!template.trim()) return "Template must not be blank";
  if (/^[\\/]/.test(template) || /^[A-Za-z]:[\\/]/.test(template)) {
    return "Template must be a relative path";
  }
  if (template.includes("\\")) return "Template paths must use forward slashes";
  if (hasControlCharacters(template)) return "Template must not contain control characters";

  const segments = template.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    return "Template must not contain empty, dot, or dot-dot path segments";
  }

  for (let index = 0; index < template.length;) {
    if (template.startsWith("{{", index) || template.startsWith("}}", index)) {
      index += 2;
      continue;
    }
    if (template[index] === "}") return "Template contains an unmatched closing brace";
    if (template[index] !== "{") {
      index += 1;
      continue;
    }
    const close = template.indexOf("}", index + 1);
    if (close < 0) return "Template contains an unmatched opening brace";
    const token = template.slice(index + 1, close);
    if (token.includes("{") || !FOLDER_PATTERN_TOKENS.has(token)) {
      return `Template contains unknown token {${token}}`;
    }
    index = close + 1;
  }
  return undefined;
}

function isAbsoluteLibraryRoot(value: string): boolean {
  return value.startsWith("/")
    || /^[A-Za-z]:[\\/]/.test(value)
    || value.startsWith("\\\\");
}

export const FolderPatternTemplateSchema = z.string().superRefine((template, context) => {
  const issue = folderPatternTemplateIssue(template);
  if (issue) context.addIssue({ code: z.ZodIssueCode.custom, message: issue });
});

export const LibraryFolderPatternSchema = z.object({
  libraryId: z.string().trim().min(1),
  rootDir: z.string().trim().min(1).refine(isAbsoluteLibraryRoot, "Library root must be absolute"),
  standalone: FolderPatternTemplateSchema,
  series: FolderPatternTemplateSchema,
  source: z.enum(["configured", "detected"]),
});
export type LibraryFolderPattern = z.infer<typeof LibraryFolderPatternSchema>;

export const LibraryFolderPatternsSchema = z.array(LibraryFolderPatternSchema).superRefine((patterns, context) => {
  const seen = new Set<string>();
  patterns.forEach((pattern, index) => {
    if (seen.has(pattern.libraryId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Each libraryId may have only one folder convention",
        path: [index, "libraryId"],
      });
    }
    seen.add(pattern.libraryId);
  });
});

// System Settings Schema for UI-configurable parameters
export const SystemSettingsSchema = z.object({
  libraryDir: z.string().default("/audiobooks"),
  inboxDir: z.string().default("/inbox"),
  absUrl: z.string().optional(),
  absToken: z.string().optional(),
  qbitUrl: z.string().optional(),
  qbitUser: z.string().optional(),
  qbitPass: z.string().optional(),
  anthropicApiKey: z.string().optional(),
  nytApiKey: z.string().optional(),
  ollamaUrl: z.string().default("http://ollama:11434"),
  ollamaModel: z.string().default("mistral-nemo:latest"),
  llmPriority: z.enum(['local-first', 'cloud-first']).default('cloud-first'),
  recommendationScope: z.enum(['both', 'shelf', 'discover']).default('discover'),
  debugLogs: z.boolean().default(true),
  actionLogLevel: z.enum(['debug', 'info', 'warn', 'error']).default('debug'),
  useProxy: z.boolean().default(true),
  proxyUrl: z.string().optional(),
  torrentTrackers: z.string().default([
    "udp://tracker.coppersurfer.tk:6969",
    "udp://tracker.leechers-paradise.org:6969",
    "udp://tracker.torrent.eu.org:451/announce",
    "udp://tracker.open-internet.nl:6969/announce",
    "udp://tracker.opentrackr.org:69691337/announce",
    "udp://tracker.vanitycore.co:6969/announce",
    "http://tracker.baravik.org:6970/announce",
    "http://retracker.telecom.by:80/announce"
  ].join("\n")),
  pathMappings: z.array(PathMappingSchema).default([]),
  libraryFolderPatterns: LibraryFolderPatternsSchema.default([]),
});

export type SystemSettings = z.infer<typeof SystemSettingsSchema>;

export const PublicSystemSettingsSchema = SystemSettingsSchema.omit({
  absToken: true,
  qbitPass: true,
  anthropicApiKey: true,
  nytApiKey: true,
  proxyUrl: true,
});

export type PublicSystemSettings = z.infer<typeof PublicSystemSettingsSchema>;

export const SettingsSecretStatusSchema = z.object({
  absTokenConfigured: z.boolean(),
  qbitPassConfigured: z.boolean(),
  anthropicApiKeyConfigured: z.boolean(),
  nytApiKeyConfigured: z.boolean(),
  proxyUrlConfigured: z.boolean(),
});

export const PublicSettingsResponseSchema = PublicSystemSettingsSchema.extend({
  secretStatus: SettingsSecretStatusSchema,
  managedByEnvironment: z.array(z.string()).default([]),
});

export type PublicSettingsResponse = z.infer<typeof PublicSettingsResponseSchema>;

export const SettingsHistoryEntrySchema = z.object({
  id: z.string().uuid(),
  createdAt: z.string().datetime(),
  actor: z.string().min(1),
  source: z.enum(["update", "rollback"]),
  changedKeys: z.array(z.string()),
  restoredFrom: z.string().uuid().optional(),
  snapshot: PublicSystemSettingsSchema,
});

export type SettingsHistoryEntry = z.infer<typeof SettingsHistoryEntrySchema>;

export interface ABBSearchResult {
  id: string;
  title: string;
  url: string;
  coverUrl: string;
  category: string;
  size: string;
  seeders: number;
  leechers: number;
  added: string;
}

export interface ABBPaginatedResponse {
  results: ABBSearchResult[];
  totalPages: number;
  currentPage: number;
}

// Shared API Models


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

export const ActionTypeSchema = z.enum(["move", "rename", "copy", "skip", "error", "duplicate"]);
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
  duplicate_abs_item_id: z.string().optional(),
});
export type OrganizationAction = z.infer<typeof OrganizationActionSchema>;

export const ScanProgressSchema = z.object({
  jobId: z.string().optional(),
  scanned: z.number(),
  total: z.number(),
  currentFile: z.string(),
  status: z.enum(["idle", "discovering", "scanning", "completed", "error", "cancelled"]),
  planOnly: z.boolean().default(false),
  results: z.array(OrganizationActionSchema).optional()
});
export type ScanProgress = z.infer<typeof ScanProgressSchema>;

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
  proxy: {
    enabled: boolean;
    working: boolean;
    ip: string | null;
    location: string | null;
  };
}
