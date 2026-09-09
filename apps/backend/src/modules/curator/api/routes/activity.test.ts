import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { errorHandler } from '../http.js';
import { createActivityRouter } from './activity.js';
import type { ApiServices } from '../services.js';

const servers: import('node:http').Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  vi.restoreAllMocks();
});

describe('Activity API & Aggregator', () => {
  let mockOperations: any;
  let mockDb: any;
  let mockIngestStore: any;
  let mockQbtService: any;
  let baseUrl: string;

  beforeEach(async () => {
    mockOperations = {
      list: vi.fn().mockReturnValue([
        {
          id: 'op_error_1',
          type: 'tag',
          status: 'error',
          error: 'Rate limit exceeded on Anthropic API',
          progress: { current: 5, total: 10, message: 'Failed on book 5' },
          startedAt: Date.now() - 3600000,
          endedAt: Date.now() - 3500000,
        },
        {
          id: 'op_running_2',
          type: 'realign',
          status: 'running',
          progress: { current: 15, total: 50, message: 'Moving files' },
          startedAt: Date.now() - 60000,
        },
        {
          id: 'op_completed_3',
          type: 'sync',
          status: 'completed',
          progress: { current: 100, total: 100 },
          startedAt: Date.now() - 7200000,
          endedAt: Date.now() - 7100000,
        },
      ]),
      get: vi.fn().mockImplementation((id: string) => {
        if (id === 'op_error_1') {
          return {
            snapshot: () => ({
              id: 'op_error_1',
              type: 'tag',
              status: 'error',
              error: 'Rate limit exceeded on Anthropic API',
            }),
          };
        }
        return null;
      }),
    };

    mockDb = {
      listEncodeQueue: vi.fn().mockReturnValue([
        {
          id: 'enc_failed_1',
          folderPath: '/library/Sample Failed Book',
          title: 'Sample Failed Book',
          status: 'failed',
          error: 'ffmpeg conversion failed',
          progress: 45,
          updatedAt: Date.now() - 1800000,
        },
        {
          id: 'enc_running_2',
          folderPath: '/library/Sample Running Book',
          title: 'Sample Running Book',
          status: 'running',
          progress: 72,
          updatedAt: Date.now() - 30000,
        },
      ]),
      listEncodeHistory: vi.fn().mockReturnValue([
        {
          id: 'enc_hist_1',
          title: 'Sample Completed Book',
          status: 'completed',
          completedAt: Date.now() - 5000000,
        },
      ]),
      getEncodeQueueItem: vi.fn().mockImplementation((id: string) => {
        if (id === 'enc_failed_1') {
          return {
            id: 'enc_failed_1',
            title: 'Sample Failed Book',
            status: 'failed',
            error: 'ffmpeg conversion failed',
          };
        }
        return null;
      }),
    };

    mockIngestStore = {
      list: vi.fn().mockReturnValue([
        {
          id: 'job_1',
          planOnly: false,
          items: [
            {
              id: 'ingest_fail_1',
              jobId: 'job_1',
              state: 'failed',
              error: 'Interrupted by restart',
              action: {
                title: 'Above the Bay of Angels',
                source_path: '/inbox/Above the Bay of Angels',
                target_path: '/library/Above the Bay of Angels',
                action_type: 'move',
              },
              updatedAt: Date.now() - 1000000,
            },
            {
              id: 'ingest_dup_2',
              jobId: 'job_1',
              state: 'discovered',
              error: null,
              action: {
                title: 'Duplicate Title',
                source_path: '/inbox/Duplicate Title',
                target_path: '/library/Duplicate Title',
                action_type: 'duplicate',
                reason: 'Exact audio files already in library',
              },
              updatedAt: Date.now() - 1200000,
            },
            {
              id: 'ingest_staging_3',
              jobId: 'job_1',
              state: 'staging',
              error: null,
              action: {
                title: 'In Progress Title',
                source_path: '/inbox/In Progress Title',
                target_path: '/library/In Progress Title',
                action_type: 'move',
              },
              updatedAt: Date.now() - 20000,
            },
            {
              id: 'ingest_complete_4',
              jobId: 'job_1',
              state: 'complete',
              error: null,
              action: {
                title: 'Shelved Title',
                source_path: '/inbox/Shelved Title',
                target_path: '/library/Shelved Title',
                action_type: 'move',
              },
              updatedAt: Date.now() - 3600000,
            },
          ],
        },
      ]),
    };

    mockQbtService = {
      getTorrents: vi.fn().mockResolvedValue([
        {
          hash: 'abc123hash',
          name: 'Project Hail Mary',
          progress: 0.65,
          dlspeed: 2500000,
          eta: 300,
          state: 'downloading',
        },
      ]),
    };

    const dummyServices: ApiServices = {
      operations: mockOperations,
      db: mockDb,
      logger: { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} },
    } as any;

    const app = express();
    app.use(express.json());
    app.use(
      createActivityRouter(dummyServices, {
        operations: mockOperations,
        db: mockDb,
        ingestStore: mockIngestStore,
        qbtService: mockQbtService,
      }),
    );
    app.use(errorHandler(dummyServices.logger));

    const server = app.listen(0);
    servers.push(server);
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  });

  it('aggregates activity feed correctly into Needs Attention, In Progress, and Completed', async () => {
    const res = await fetch(`${baseUrl}/activity/feed`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;

    expect(body.success).toBe(true);
    expect(body.counts.needsAttention).toBe(4); // op_error_1, enc_failed_1, ingest_fail_1, ingest_dup_2
    expect(body.counts.inProgress).toBe(4); // op_running_2, enc_running_2, ingest_staging_3, torrent
    expect(body.counts.completed).toBe(3); // op_completed_3, enc_hist_1, ingest_complete_4

    // Verify Needs Attention action items
    const ingestFail = body.needsAttention.find((i: any) => i.id === 'ing_ingest_fail_1');
    expect(ingestFail).toBeDefined();
    expect(ingestFail.title).toBe('Above the Bay of Angels');
    expect(ingestFail.actionRequired?.type).toBe('review_intake');

    const opFail = body.needsAttention.find((i: any) => i.id === 'op_op_error_1');
    expect(opFail).toBeDefined();
    expect(opFail.error).toContain('Rate limit exceeded');

    // Verify In Progress items
    const torrent = body.inProgress.find((i: any) => i.id === 'tor_abc123hash');
    expect(torrent).toBeDefined();
    expect(torrent.title).toBe('Project Hail Mary');
    expect(torrent.progress.percent).toBe(65);

    // Verify providers
    expect(body.providers.operations).toBe('ok');
    expect(body.providers.encodes).toBe('ok');
    expect(body.providers.ingest).toBe('ok');
    expect(body.providers.torrents).toBe('ok');
  });

  it('reports provider error honestly when torrent service fails', async () => {
    mockQbtService.getTorrents.mockRejectedValueOnce(new Error('Connection refused to qBittorrent'));

    const res = await fetch(`${baseUrl}/activity/feed`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;

    expect(body.success).toBe(true);
    expect(body.providers.torrents).toBe('error');
    expect(body.providerErrors?.torrents).toContain('Connection refused');
  });

  it('resolves an entity by ID when present', async () => {
    const res = await fetch(`${baseUrl}/activity/entities/op_error_1`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.success).toBe(true);
    expect(body.found).toBe(true);
    expect(body.entity.id).toBe('op_op_error_1');
    expect(body.entity.title).toContain('tag');
  });

  it('resolves an ingest entity by raw ID', async () => {
    const res = await fetch(`${baseUrl}/activity/entities/ingest_fail_1`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.success).toBe(true);
    expect(body.found).toBe(true);
    expect(body.entity.title).toBe('Above the Bay of Angels');
  });

  it('returns 404 with honest unavailable message when entity is not found', async () => {
    const res = await fetch(`${baseUrl}/activity/entities/nonexistent_id`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as any;
    expect(body.success).toBe(false);
    expect(body.found).toBe(false);
    expect(body.unavailableReason).toContain('was not found or has expired');
  });
});
