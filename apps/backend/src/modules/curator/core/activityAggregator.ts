import path from 'node:path';
import type { OperationRegistry } from './operations.js';
import type { CuratorDb } from './db.js';
import type { IngestStore } from '../../librarian/ingestStore.js';
import type { QBittorrentService, QbitTorrent } from '../../librarian/services/qbittorrent.js';

export type ActivityEntityType = 'curator_op' | 'encode_job' | 'ingest_item' | 'torrent';

export interface ActivityItem {
  id: string;
  entityType: ActivityEntityType;
  rawId: string;
  title: string;
  subtitle?: string;
  status: 'error' | 'requires_input' | 'running' | 'queued' | 'completed' | 'cancelled';
  category: 'needs_attention' | 'in_progress' | 'completed';
  progress?: {
    current?: number;
    total?: number;
    percent?: number;
    speed?: string;
    eta?: number;
    message?: string;
  };
  error?: string;
  actionRequired?: {
    type: 'review_intake' | 'dismiss_acquisition' | 'inspect_op' | 'retry_encode';
    label: string;
    targetRoute?: string;
  };
  updatedAt: number;
  startedAt?: number;
  completedAt?: number;
}

export interface ActivityFeedResponse {
  success: boolean;
  needsAttention: ActivityItem[];
  inProgress: ActivityItem[];
  completed: ActivityItem[];
  counts: {
    needsAttention: number;
    inProgress: number;
    completed: number;
  };
  providers: {
    operations: 'ok' | 'error';
    encodes: 'ok' | 'error';
    ingest: 'ok' | 'error';
    torrents: 'ok' | 'error' | 'not-configured';
  };
  providerErrors?: Partial<Record<'operations' | 'encodes' | 'ingest' | 'torrents', string>>;
  generatedAt: number;
  retentionWindowMs: number;
}

export interface ActivityEntityResult {
  found: boolean;
  entity?: ActivityItem;
  rawDetails?: unknown;
  unavailableReason?: string;
}

export interface ActivityAggregatorDependencies {
  operations?: OperationRegistry;
  db?: CuratorDb;
  ingestStore?: IngestStore;
  qbtService?: QBittorrentService;
}

const RETENTION_WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours

const INGEST_PROCESSING_STATES = new Set([
  'approved',
  'staging',
  'finalized',
  'scan_requested',
  'abs_item_resolved',
  'enriched',
]);

const INGEST_STATE_LABELS: Record<string, string> = {
  approved: 'Approved, preparing',
  staging: 'Moving files to library',
  finalized: 'Finalizing metadata',
  scan_requested: 'Audiobookshelf library scan requested',
  abs_item_resolved: 'Resolving in Audiobookshelf',
  enriched: 'Applying library tags',
};

function formatSpeed(bytesPerSec: number): string {
  if (bytesPerSec <= 0) return '0 KB/s';
  const mb = bytesPerSec / 1024 / 1024;
  if (mb >= 1) return `${mb.toFixed(1)} MB/s`;
  const kb = bytesPerSec / 1024;
  return `${kb.toFixed(0)} KB/s`;
}

export class ActivityAggregator {
  constructor(private deps: ActivityAggregatorDependencies) {}

  public async getFeed(now = Date.now()): Promise<ActivityFeedResponse> {
    const needsAttention: ActivityItem[] = [];
    const inProgress: ActivityItem[] = [];
    const completed: ActivityItem[] = [];
    const providerStatus: ActivityFeedResponse['providers'] = {
      operations: 'ok',
      encodes: 'ok',
      ingest: 'ok',
      torrents: 'ok',
    };
    const providerErrors: Record<string, string> = {};
    const cutoff = now - RETENTION_WINDOW_MS;

    // 1. Curator Operations
    if (this.deps.operations) {
      try {
        const ops = this.deps.operations.list();
        for (const op of ops) {
          const item = this.mapOperation(op);
          if (item.category === 'needs_attention') {
            needsAttention.push(item);
          } else if (item.category === 'in_progress') {
            inProgress.push(item);
          } else if (item.category === 'completed' && item.updatedAt >= cutoff) {
            completed.push(item);
          }
        }
      } catch (err: unknown) {
        providerStatus.operations = 'error';
        providerErrors.operations = (err as Error).message || 'Failed to list operations';
      }
    }

    // 2. M4B Encodes (Queue and History)
    if (this.deps.db) {
      try {
        const queue = this.deps.db.listEncodeQueue();
        for (const queueItem of queue) {
          const item = this.mapEncodeQueueItem(queueItem);
          if (item.category === 'needs_attention') {
            needsAttention.push(item);
          } else if (item.category === 'in_progress') {
            inProgress.push(item);
          }
        }

        const history = this.deps.db.listEncodeHistory(30);
        for (const histItem of history) {
          const item = this.mapEncodeHistoryItem(histItem);
          if (item && item.updatedAt >= cutoff) {
            completed.push(item);
          }
        }
      } catch (err: unknown) {
        providerStatus.encodes = 'error';
        providerErrors.encodes = (err as Error).message || 'Failed to list encode jobs';
      }
    }

    // 3. Ingest Store Items
    if (this.deps.ingestStore) {
      try {
        const jobs = this.deps.ingestStore.list().filter((j) => !j.planOnly);
        for (const job of jobs) {
          for (const ingestItem of job.items) {
            const mapped = this.mapIngestItem(ingestItem);
            if (!mapped) continue;
            if (mapped.category === 'needs_attention') {
              needsAttention.push(mapped);
            } else if (mapped.category === 'in_progress') {
              inProgress.push(mapped);
            } else if (mapped.category === 'completed' && mapped.updatedAt >= cutoff) {
              completed.push(mapped);
            }
          }
        }
      } catch (err: unknown) {
        providerStatus.ingest = 'error';
        providerErrors.ingest = (err as Error).message || 'Failed to list ingest jobs';
      }
    }

    // 4. Torrents / Acquisitions
    if (this.deps.qbtService) {
      try {
        const torrents = await this.deps.qbtService.getTorrents('all', 'audiobooks');
        for (const torrent of torrents) {
          if (torrent.progress < 1) {
            inProgress.push(this.mapTorrent(torrent));
          }
        }
      } catch (err: unknown) {
        providerStatus.torrents = 'error';
        providerErrors.torrents = (err as Error).message || 'Failed to connect to torrent client';
      }
    } else {
      providerStatus.torrents = 'not-configured';
    }

    // Sort sections by updatedAt descending (most recent first)
    needsAttention.sort((a, b) => b.updatedAt - a.updatedAt);
    inProgress.sort((a, b) => b.updatedAt - a.updatedAt);
    completed.sort((a, b) => b.updatedAt - a.updatedAt);

    return {
      success: true,
      needsAttention,
      inProgress,
      completed,
      counts: {
        needsAttention: needsAttention.length,
        inProgress: inProgress.length,
        completed: completed.length,
      },
      providers: providerStatus,
      ...(Object.keys(providerErrors).length > 0 ? { providerErrors } : {}),
      generatedAt: now,
      retentionWindowMs: RETENTION_WINDOW_MS,
    };
  }

  public async resolveEntity(id: string): Promise<ActivityEntityResult> {
    const rawId = id.replace(/^(op|enc|ing|tor)_/, '');

    // 1. Check Operations
    if (this.deps.operations) {
      const op = this.deps.operations.get(rawId) || (id !== rawId ? this.deps.operations.get(id) : null);
      if (op) {
        const snapshot = op.snapshot();
        return {
          found: true,
          entity: this.mapOperation(snapshot),
          rawDetails: snapshot,
        };
      }
    }

    // 2. Check Encode Queue & History
    if (this.deps.db) {
      const queueItem = this.deps.db.getEncodeQueueItem(rawId);
      if (queueItem) {
        return {
          found: true,
          entity: this.mapEncodeQueueItem(queueItem),
          rawDetails: queueItem,
        };
      }
      const history = this.deps.db.listEncodeHistory(50);
      const histItem = history.find((h: any) => h.id === rawId || h.id === id);
      if (histItem) {
        return {
          found: true,
          entity: this.mapEncodeHistoryItem(histItem)!,
          rawDetails: histItem,
        };
      }
    }

    // 3. Check Ingest Store
    if (this.deps.ingestStore) {
      const jobs = this.deps.ingestStore.list();
      for (const job of jobs) {
        const match = job.items.find((i) => i.id === rawId || i.id === id);
        if (match) {
          const mapped = this.mapIngestItem(match);
          return {
            found: true,
            entity: mapped ?? undefined,
            rawDetails: match,
          };
        }
      }
    }

    // 4. Check Torrents
    if (this.deps.qbtService) {
      try {
        const torrents = await this.deps.qbtService.getTorrents('all', 'audiobooks');
        const match = torrents.find((t) => t.hash.toLowerCase() === rawId.toLowerCase() || t.hash.toLowerCase() === id.toLowerCase());
        if (match) {
          return {
            found: true,
            entity: this.mapTorrent(match),
            rawDetails: match,
          };
        }
      } catch {
        // qbt unreachable or error
      }
    }

    return {
      found: false,
      unavailableReason: `Activity entity "${id}" was not found or has expired from active retention.`,
    };
  }

  private mapOperation(op: any): ActivityItem {
    const isError = op.status === 'error';
    const isRunning = op.status === 'running' || op.status === 'pending' || op.status === 'paused';
    const isCompleted = op.status === 'completed';
    const category = isError ? 'needs_attention' : isRunning ? 'in_progress' : 'completed';

    const current = op.progress?.current ?? 0;
    const total = op.progress?.total ?? 0;
    const percent = total > 0 ? Math.round((current / total) * 100) : 0;

    return {
      id: `op_${op.id}`,
      entityType: 'curator_op',
      rawId: op.id,
      title: `Operation: ${op.type}`,
      subtitle: op.progress?.message || op.status,
      status: isError ? 'error' : isRunning ? (op.status === 'pending' ? 'queued' : 'running') : isCompleted ? 'completed' : 'cancelled',
      category,
      progress: {
        current,
        total,
        percent,
        message: op.progress?.message,
      },
      error: op.error,
      ...(isError
        ? {
            actionRequired: {
              type: 'inspect_op',
              label: 'Inspect Operation',
            },
          }
        : {}),
      updatedAt: op.endedAt || op.startedAt || Date.now(),
      startedAt: op.startedAt,
      completedAt: op.endedAt,
    };
  }

  private mapEncodeQueueItem(item: any): ActivityItem {
    const isFailed = item.status === 'failed';
    const isRunning = item.status === 'running' || item.status === 'queued';
    const category = isFailed ? 'needs_attention' : isRunning ? 'in_progress' : 'completed';

    return {
      id: `enc_${item.id}`,
      entityType: 'encode_job',
      rawId: item.id,
      title: item.title || item.folderPath ? path.basename(item.folderPath || '') : `Encode ${item.id}`,
      subtitle: item.status === 'running' ? 'Encoding to M4B' : item.status === 'queued' ? 'Queued for encoding' : 'Encode failed',
      status: isFailed ? 'error' : item.status === 'queued' ? 'queued' : 'running',
      category,
      progress: {
        percent: item.progress ?? 0,
        message: item.status === 'running' ? `${item.progress ?? 0}% encoded` : undefined,
      },
      error: item.error,
      ...(isFailed
        ? {
            actionRequired: {
              type: 'retry_encode',
              label: 'Review in M4B Encoder',
              targetRoute: '/curate/encode',
            },
          }
        : {}),
      updatedAt: item.updatedAt || Date.now(),
    };
  }

  private mapEncodeHistoryItem(hist: any): ActivityItem | null {
    return {
      id: `enc_${hist.id}`,
      entityType: 'encode_job',
      rawId: hist.id,
      title: hist.title || (hist.folderPath ? path.basename(hist.folderPath) : `Encode ${hist.id}`),
      subtitle: hist.status === 'completed' ? 'Successfully converted to M4B' : 'Conversion ended',
      status: hist.status === 'completed' ? 'completed' : 'error',
      category: 'completed',
      progress: { percent: 100 },
      updatedAt: hist.completedAt || hist.updatedAt || Date.now(),
      completedAt: hist.completedAt,
    };
  }

  private mapIngestItem(item: any): ActivityItem | null {
    const title = item.action?.title || (item.action?.source_path ? path.basename(item.action.source_path) : `Item ${item.id}`);

    // Needs attention: failed OR discovered with duplicate/error
    if (item.state === 'failed' || (item.state === 'discovered' && (item.action?.action_type === 'duplicate' || item.action?.action_type === 'error'))) {
      return {
        id: `ing_${item.id}`,
        entityType: 'ingest_item',
        rawId: item.id,
        title,
        subtitle: item.error || item.action?.reason || 'Requires review before import',
        status: item.state === 'failed' ? 'error' : 'requires_input',
        category: 'needs_attention',
        error: item.error,
        actionRequired: {
          type: 'review_intake',
          label: 'Review in Intake',
          targetRoute: '/scout/intake',
        },
        updatedAt: item.updatedAt || Date.now(),
      };
    }

    // In progress
    if (INGEST_PROCESSING_STATES.has(item.state) && item.action?.action_type !== 'skip') {
      return {
        id: `ing_${item.id}`,
        entityType: 'ingest_item',
        rawId: item.id,
        title,
        subtitle: INGEST_STATE_LABELS[item.state] || 'Processing',
        status: 'running',
        category: 'in_progress',
        updatedAt: item.updatedAt || Date.now(),
      };
    }

    // Completed
    if (item.state === 'complete') {
      return {
        id: `ing_${item.id}`,
        entityType: 'ingest_item',
        rawId: item.id,
        title,
        subtitle: 'Shelved into library',
        status: 'completed',
        category: 'completed',
        progress: { percent: 100 },
        updatedAt: item.updatedAt || Date.now(),
        completedAt: item.updatedAt,
      };
    }

    return null;
  }

  private mapTorrent(torrent: QbitTorrent): ActivityItem {
    const percent = Math.max(0, Math.min(100, Math.round(torrent.progress * 100)));
    const speed = torrent.dlspeed > 0 ? formatSpeed(torrent.dlspeed) : torrent.state;

    return {
      id: `tor_${torrent.hash}`,
      entityType: 'torrent',
      rawId: torrent.hash,
      title: torrent.name,
      subtitle: `${speed}${torrent.eta > 0 && torrent.eta < 86400 ? ` · ETA ${Math.round(torrent.eta / 60)}m` : ''}`,
      status: 'running',
      category: 'in_progress',
      progress: {
        percent,
        speed: formatSpeed(torrent.dlspeed),
        eta: torrent.eta,
      },
      updatedAt: Date.now(),
    };
  }
}
