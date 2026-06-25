/**
 * ffprobe wrapper — best-effort audio metadata for the scanner and post-encode
 * verification.
 *
 * The runner is injectable (`ExecFileFn`) following the project's dependency-
 * injection convention (cf. ABSClient.fetchImpl), so tests exercise the JSON
 * parsing / aggregation logic without a real ffprobe binary.
 */
import { execFile } from 'node:child_process';

import { nullLogger, type Logger } from '../logger.js';
import type { AudioProbe } from './encodeTypes.js';

/** Minimal injectable exec surface. */
export type ExecFileFn = (cmd: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;

export interface ProbeDeps {
  ffprobePath: string;
  execFileImpl?: ExecFileFn;
  logger?: Logger;
}

/** Default exec adapter over node:child_process.execFile (bounded output). */
export function defaultExecFile(): ExecFileFn {
  return (cmd, args) =>
    new Promise((resolve, reject) => {
      execFile(cmd, args, { maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) {
          // Attach stderr so the caller can distinguish "not found" from "bad input".
          (err as Error & { stderr?: string }).stderr = stderr;
          reject(err);
          return;
        }
        resolve({ stdout, stderr });
      });
    });
}

const FFPROBE_ARGS = [
  '-v',
  'quiet',
  '-print_format',
  'json',
  '-show_format',
  '-show_streams',
  '-show_chapters',
];

interface FfprobeJson {
  format?: { duration?: string; bit_rate?: string };
  streams?: Array<{
    codec_type?: string;
    codec_name?: string;
    bit_rate?: string;
    sample_rate?: string;
    channels?: number;
  }>;
  chapters?: unknown[];
}

function toNumber(value: string | undefined): number | null {
  if (value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Probe a single audio file. Returns null on any failure (best-effort). */
export async function probeFile(file: string, deps: ProbeDeps): Promise<AudioProbe | null> {
  const exec = deps.execFileImpl ?? defaultExecFile();
  const logger = deps.logger ?? nullLogger;
  try {
    const { stdout } = await exec(deps.ffprobePath, [...FFPROBE_ARGS, file]);
    const json = JSON.parse(stdout) as FfprobeJson;
    const audio = json.streams?.find((s) => s.codec_type === 'audio') ?? json.streams?.[0];
    return {
      codec: audio?.codec_name ?? null,
      bitRate: toNumber(audio?.bit_rate) ?? toNumber(json.format?.bit_rate),
      sampleRate: toNumber(audio?.sample_rate),
      channels: audio?.channels ?? null,
      durationSeconds: toNumber(json.format?.duration),
      chapterCount: Array.isArray(json.chapters) ? json.chapters.length : 0,
    };
  } catch (err) {
    logger.debug('ffprobe failed', { file, error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

/**
 * Probe a candidate folder: take codec/bitrate/etc. from the first file and sum
 * durations across all files (the total length of the eventual .m4b).
 */
export async function probeCandidate(files: string[], deps: ProbeDeps): Promise<AudioProbe | null> {
  if (files.length === 0) return null;
  const first = files[0];
  if (first === undefined) return null;
  const head = await probeFile(first, deps);
  if (!head) return null;

  let totalDuration = head.durationSeconds ?? 0;
  let totalChapters = head.chapterCount;
  for (const file of files.slice(1)) {
    const p = await probeFile(file, deps);
    if (p?.durationSeconds) totalDuration += p.durationSeconds;
    totalChapters += p?.chapterCount ?? 0;
  }
  return {
    ...head,
    durationSeconds: totalDuration > 0 ? totalDuration : head.durationSeconds,
    chapterCount: totalChapters,
  };
}
