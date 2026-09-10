import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { errorHandler } from '../http.js';
import { createActivityRouter } from './activity.js';
import type { ApiServices } from '../services.js';
import type { OperationController, OperationRegistry, OperationSnapshot } from '../../core/operations.js';
import type { CuratorDb } from '../../core/db.js';
import type { QBittorrentService } from '../../../librarian/services/qbittorrent.js';
import type { EncodeHistoryItem, EncodeQueueItem } from '../../core/encoder/encodeTypes.js';
import type { IngestJob, IngestStore } from '../../../librarian/ingestStore.js';
import type { OrganizationAction } from '@audioshelf/shared';

const servers: import('node:http').Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  vi.restoreAllMocks();
});

describe('Activity API & Aggregator', () => {
  // These fixtures are typed against the real return types on purpose. They
  // previously described a shape no producer ever emits (an encode status of
  // 'failed', operations with `endedAt`, queue rows with `title`/`progress`),
  // so the aggregator was written to read fields that are always undefined in
  // production while the suite stayed green.
  let mockOperations: Pick<OperationRegistry, 'list' | 'get'>;
  let mockDb: Pick<
    CuratorDb,
    | 'listEncodeQueue'
    | 'listEncodeHistory'
    | 'getEncodeQueueItem'
    | 'listAcquisitions'
    | 'getAcquisition'
  >;
  let mockIngestStore: Pick<IngestStore, 'list'>;
  let mockQbtService: { getTorrents: ReturnType<typeof vi.fn> };
  let baseUrl: string;

  beforeEach(async () => {
    const errorSnapshot: OperationSnapshot = {
      id: 'op_error_1',
      type: 'tag',
      status: 'error',
      error: { code: 'LLM_RATE_LIMIT', message: 'Rate limit exceeded on Anthropic API' },
      progress: { phase: 'tag', current: 5, total: 10, message: 'Failed on book 5' },
      createdAt: Date.now() - 3600000,
      updatedAt: Date.now() - 3500000,
      finishedAt: Date.now() - 3500000,
      summary: null,
    };
    const snapshots: OperationSnapshot[] = [
      errorSnapshot,
      {
        id: 'op_running_2',
        type: 'push',
        status: 'running',
        error: null,
        progress: { phase: 'realign', current: 15, total: 50, message: 'Moving files' },
        createdAt: Date.now() - 60000,
        updatedAt: Date.now() - 30000,
        finishedAt: null,
        summary: null,
      },
      {
        id: 'op_completed_3',
        type: 'sync',
        status: 'completed',
        error: null,
        progress: { phase: 'sync', current: 100, total: 100 },
        createdAt: Date.now() - 7200000,
        updatedAt: Date.now() - 7100000,
        finishedAt: Date.now() - 7100000,
        summary: null,
      },
    ];

    mockOperations = {
      list: vi.fn().mockReturnValue(snapshots),
      get: vi.fn().mockImplementation((id: string) =>
        id === 'op_error_1' ? ({ snapshot: () => errorSnapshot } as OperationController) : undefined,
      ),
    } as unknown as Pick<OperationRegistry, 'list' | 'get'>;

    const failedEncode: EncodeQueueItem = {
      id: 'enc_failed_1',
      libraryId: 'lib_1',
      name: 'Sample Failed Book',
      author: 'A. Author',
      totalBytes: 1_000_000,
      status: 'error',
      sortOrder: 1,
      addedAt: Date.now() - 1800000,
      detail: { message: 'ffmpeg conversion failed', percent: 45 },
    };
    const queue: EncodeQueueItem[] = [
      failedEncode,
      {
        id: 'enc_running_2',
        libraryId: 'lib_1',
        name: 'Sample Running Book',
        author: 'B. Author',
        totalBytes: 2_000_000,
        status: 'running',
        sortOrder: 2,
        addedAt: Date.now() - 30000,
        detail: { message: '72% encoded', percent: 72 },
      },
    ];
    const history: EncodeHistoryItem[] = [
      {
        id: 1,
        libraryItemId: 'enc_hist_1',
        name: 'Sample Completed Book',
        author: 'C. Author',
        totalBytes: 3_000_000,
        status: 'completed',
        startedAt: Date.now() - 5100000,
        finishedAt: Date.now() - 5000000,
        detail: null,
      },
    ];

    mockDb = {
      listEncodeQueue: vi.fn().mockReturnValue(queue),
      listEncodeHistory: vi.fn().mockReturnValue(history),
      getEncodeQueueItem: vi.fn().mockImplementation((id: string) =>
        id === 'enc_failed_1' ? failedEncode : undefined,
      ),
      // The aggregator reads acquisitions in both getFeed and resolveEntity.
      // resolveEntity does not guard that call, so a mock missing these throws
      // and the "not found" case answers 500 instead of 404.
      listAcquisitions: vi.fn().mockReturnValue([]),
      getAcquisition: vi.fn().mockReturnValue(null),
    } as unknown as Pick<
    CuratorDb,
    | 'listEncodeQueue'
    | 'listEncodeHistory'
    | 'getEncodeQueueItem'
    | 'listAcquisitions'
    | 'getAcquisition'
  >;

    // OrganizationAction carries the title on `book`, not at the top level.
    const action = (title: string, actionType: OrganizationAction['action_type'], reason = ''): OrganizationAction =>
      ({
        book: { title } as OrganizationAction['book'],
        action_type: actionType,
        source_path: `/inbox/${title}`,
        target_path: `/library/${title}`,
        reason,
        executed: false,
        success: false,
      }) as OrganizationAction;

    const ingestJobs: IngestJob[] = [
      {
        id: 'job_1',
        state: 'discovered',
        targetDir: '/library',
        libraryId: 'lib_1',
        planOnly: false,
        createdAt: Date.now() - 2000000,
        updatedAt: Date.now() - 20000,
        items: [
          {
            id: 'ingest_fail_1',
            jobId: 'job_1',
            state: 'failed',
            error: 'Interrupted by restart',
            attempts: 1,
            absItemId: null,
            action: action('Above the Bay of Angels', 'move'),
            updatedAt: Date.now() - 1000000,
          },
          {
            id: 'ingest_dup_2',
            jobId: 'job_1',
            state: 'discovered',
            error: null,
            attempts: 0,
            absItemId: null,
            action: action('Duplicate Title', 'duplicate', 'Exact audio files already in library'),
            updatedAt: Date.now() - 1200000,
          },
          {
            id: 'ingest_staging_3',
            jobId: 'job_1',
            state: 'staging',
            error: null,
            attempts: 0,
            absItemId: null,
            action: action('In Progress Title', 'move'),
            updatedAt: Date.now() - 20000,
          },
          {
            id: 'ingest_complete_4',
            jobId: 'job_1',
            state: 'complete',
            error: null,
            attempts: 0,
            absItemId: null,
            action: action('Shelved Title', 'move'),
            updatedAt: Date.now() - 3600000,
          },
        ],
      },
    ];

    mockIngestStore = {
      list: vi.fn().mockReturnValue(ingestJobs),
    } as unknown as Pick<IngestStore, 'list'>;

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
        // The fixtures above are deliberately typed as the narrow slice each
        // mock implements; the aggregator's dependency bag asks for the whole
        // class, so widen only here.
        operations: mockOperations as OperationRegistry,
        db: mockDb as CuratorDb,
        ingestStore: mockIngestStore as IngestStore,
        qbtService: mockQbtService as unknown as QBittorrentService,
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
