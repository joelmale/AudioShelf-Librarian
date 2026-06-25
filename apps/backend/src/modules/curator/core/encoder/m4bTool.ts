/**
 * m4b-tool subprocess wrapper ([MADP-FULL]).
 *
 * Design constraints (adversarial cases mirror the ABS client's):
 *  - Spawn via argv array — source paths are NEVER shell-interpolated, so a
 *    folder named `; rm -rf /` cannot inject a command.
 *  - stdout+stderr are buffered into whole lines and forwarded to an `onLine`
 *    sink (for the WS console + ActionLog) and scanned for progress.
 *  - A non-zero exit maps to EncodeError; an ENOENT spawn error maps to
 *    EncodeToolMissingError — never a bare throw.
 *  - An AbortSignal kills the process so a cancelled operation tears the encode
 *    down promptly; the resulting close is reported as cancelled, not an error.
 *
 * `spawn` is injectable (defaults to node:child_process.spawn) so tests drive
 * progress parsing, exit handling, and cancellation without a real binary.
 */
import { spawn as nodeSpawn } from 'node:child_process';

import { EncodeError, EncodeToolMissingError } from '../errors.js';
import { nullLogger, type Logger } from '../logger.js';
import type { ProgressUpdate } from '../types.js';

export type SpawnFn = typeof nodeSpawn;

export interface M4bToolRequest {
  /** Ordered source audio files. */
  files: string[];
  /** Absolute path of the .m4b to produce. */
  outputPath: string;
  audioCodec: string;
  /** e.g. "64k"; empty string lets m4b-tool choose. */
  bitRate: string;
  /** Total source duration (sec), used to convert ffmpeg `time=` into percent. */
  totalDurationSeconds?: number | null;
  signal?: AbortSignal;
  onLine?: (line: string) => void;
  onProgress?: (update: ProgressUpdate) => void;
}

export interface M4bToolDeps {
  m4bToolPath: string;
  spawnImpl?: SpawnFn;
  logger?: Logger;
}

export interface M4bToolOutcome {
  cancelled: boolean;
}

/** Build the m4b-tool argv. Exported for unit assertions. */
export function buildM4bArgs(req: M4bToolRequest): string[] {
  const args = ['merge'];
  args.push('--output-file', req.outputPath);
  if (req.audioCodec) args.push('--audio-codec', req.audioCodec);
  if (req.bitRate) args.push('--audio-bitrate', req.bitRate);
  // Inputs last: the source files (NOT shell-quoted — passed as discrete argv).
  // m4b-tool merge auto-derives one chapter per input file (the canonical layout).
  for (const f of req.files) args.push(f);
  return args;
}

/** Parse an ffmpeg-style `time=HH:MM:SS.xx` token into seconds, or null. */
export function parseTimeToSeconds(line: string): number | null {
  const m = /time=(\d+):(\d{2}):(\d{2})(?:\.(\d+))?/.exec(line);
  if (!m) return null;
  const [, h, min, s, frac] = m;
  const seconds =
    Number(h) * 3600 + Number(min) * 60 + Number(s) + (frac ? Number(`0.${frac}`) : 0);
  return Number.isFinite(seconds) ? seconds : null;
}

/**
 * Run m4b-tool for one candidate. Resolves on success (or cancellation);
 * rejects with a typed AppError on failure.
 */
export function runM4bTool(req: M4bToolRequest, deps: M4bToolDeps): Promise<M4bToolOutcome> {
  const spawn = deps.spawnImpl ?? nodeSpawn;
  const logger = deps.logger ?? nullLogger;
  const args = buildM4bArgs(req);

  return new Promise<M4bToolOutcome>((resolve, reject) => {
    let child: ReturnType<SpawnFn>;
    try {
      child = spawn(deps.m4bToolPath, args, { signal: req.signal });
    } catch (err) {
      reject(new EncodeToolMissingError(`Could not spawn ${deps.m4bToolPath}`, { cause: String(err) }));
      return;
    }

    let cancelled = false;
    let lastLine = '';
    const total = req.totalDurationSeconds ?? null;

    const handleLine = (line: string): void => {
      if (line.trim() === '') return;
      lastLine = line;
      req.onLine?.(line);
      if (total && total > 0 && req.onProgress) {
        const sec = parseTimeToSeconds(line);
        if (sec !== null) {
          req.onProgress({
            phase: 'encode',
            current: Math.min(sec, total),
            total,
            message: 'transcoding',
          });
        }
      }
    };

    // Line-buffer a stream: emit complete lines, hold the partial tail.
    const attach = (stream: NodeJS.ReadableStream | null): void => {
      if (!stream) return;
      let buf = '';
      stream.setEncoding('utf8');
      stream.on('data', (chunk: string) => {
        buf += chunk;
        let nl = buf.indexOf('\n');
        while (nl !== -1) {
          handleLine(buf.slice(0, nl).replace(/\r$/, ''));
          buf = buf.slice(nl + 1);
          nl = buf.indexOf('\n');
        }
      });
      stream.on('end', () => {
        if (buf !== '') handleLine(buf.replace(/\r$/, ''));
      });
    };

    attach(child.stdout);
    attach(child.stderr);

    req.signal?.addEventListener(
      'abort',
      () => {
        cancelled = true;
      },
      { once: true }
    );

    child.on('error', (err: NodeJS.ErrnoException) => {
      if (cancelled || err.name === 'AbortError') {
        resolve({ cancelled: true });
        return;
      }
      if (err.code === 'ENOENT') {
        reject(new EncodeToolMissingError(`m4b-tool not found at "${deps.m4bToolPath}"`, { cause: err.message }));
        return;
      }
      reject(new EncodeError(`m4b-tool failed to run: ${err.message}`, undefined, err));
    });

    child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
      if (cancelled || signal !== null) {
        logger.debug('m4b-tool cancelled', { output: req.outputPath, signal });
        resolve({ cancelled: true });
        return;
      }
      if (code === 0) {
        resolve({ cancelled: false });
        return;
      }
      reject(
        new EncodeError(`m4b-tool exited with code ${code ?? 'null'}`, {
          outputPath: req.outputPath,
          lastLine: lastLine.slice(0, 500),
        })
      );
    });
  });
}
