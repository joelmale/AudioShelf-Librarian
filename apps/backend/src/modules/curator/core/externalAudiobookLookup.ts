import { z } from 'zod';

export interface ExternalAudiobookCandidate {
  title: string;
  author: string;
  reason: string;
}

export interface VerifiedExternalAudiobook extends ExternalAudiobookCandidate {
  description: string | null;
  durationSeconds: number | null;
  genre: string | null;
  coverUrl: string | null;
  storeUrl: string | null;
}

export interface ExternalAudiobookVerifier {
  verify(
    candidate: ExternalAudiobookCandidate,
    constraints?: { maxDurationHours?: number | null },
  ): Promise<VerifiedExternalAudiobook | null>;
}

interface ItunesAudiobook {
  collectionName?: string;
  artistName?: string;
  description?: string;
  trackTimeMillis?: number;
  primaryGenreName?: string;
  artworkUrl100?: string;
  collectionViewUrl?: string;
}

const itunesPayloadSchema = z.object({
  results: z.array(z.object({
    collectionName: z.string().max(500).optional(),
    artistName: z.string().max(500).optional(),
    description: z.string().max(20_000).optional(),
    trackTimeMillis: z.number().finite().nonnegative().optional(),
    primaryGenreName: z.string().max(200).optional(),
    artworkUrl100: z.string().max(2_048).optional(),
    collectionViewUrl: z.string().max(2_048).optional(),
  }).passthrough()).max(5),
});

function cleanEditionMarker(title: string): string {
  return title
    .replace(/[([](?:un)?abridged(?:\s+edition)?[)\]]/gi, '')
    .replace(/[\s,:;–—-]+(?:un)?abridged(?:\s+edition)?\s*$/i, '')
    .trim();
}

function candidateMatches(candidate: ExternalAudiobookCandidate, result: ItunesAudiobook): boolean {
  const wantedTitle = cleanEditionMarker(candidate.title);
  const foundTitle = cleanEditionMarker(result.collectionName ?? '');
  const foundAuthor = result.artistName ?? '';
  return Boolean(wantedTitle && foundTitle && candidate.author && foundAuthor)
    && wantedTitle === foundTitle
    && candidate.author === foundAuthor;
}

const verifierOptionsSchema = z.object({
  timeoutMs: z.number().int().positive().max(120_000).default(10_000),
  maxResponseBytes: z.number().int().positive().max(2_000_000).default(256_000),
});

const verifierConstraintsSchema = z.object({
  maxDurationHours: z.number().positive().max(100).nullable().optional(),
});

async function readBoundedJson(response: Response, maxResponseBytes: number): Promise<unknown> {
  const contentLength = response.headers.get('content-length');
  if (contentLength !== null) {
    const declared = Number(contentLength);
    if (!Number.isFinite(declared) || declared < 0 || declared > maxResponseBytes) return null;
  }
  if (!response.body) return null;

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxResponseBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
}

export function createItunesAudiobookVerifier(options: {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxResponseBytes?: number;
} = {}): ExternalAudiobookVerifier {
  const fetchImpl = options.fetchImpl ?? fetch;
  const { timeoutMs, maxResponseBytes } = verifierOptionsSchema.parse({
    timeoutMs: options.timeoutMs,
    maxResponseBytes: options.maxResponseBytes,
  });

  return {
    async verify(candidate, constraints = {}): Promise<VerifiedExternalAudiobook | null> {
      try {
        const verifiedConstraints = verifierConstraintsSchema.parse(constraints);
        const term = encodeURIComponent(`${candidate.title} ${candidate.author}`);
        const response = await fetchImpl(
          `https://itunes.apple.com/search?term=${term}&media=audiobook&limit=5`,
          { signal: AbortSignal.timeout(timeoutMs) },
        );
        if (!response.ok) return null;

        const parsed = itunesPayloadSchema.safeParse(await readBoundedJson(response, maxResponseBytes));
        if (!parsed.success) return null;
        const match = parsed.data.results.find((item) => candidateMatches(candidate, item));
        if (!match?.collectionName || !match.artistName) return null;

        const durationSeconds = match.trackTimeMillis === undefined
          ? null
          : Math.round(match.trackTimeMillis / 1000);
        const maxDurationHours = verifiedConstraints.maxDurationHours ?? null;
        // A strict duration constraint requires affirmative evidence. Unknown
        // runtime is preserved as null when unconstrained, but cannot be
        // represented as satisfying a bound that iTunes did not substantiate.
        if (maxDurationHours !== null
          && (durationSeconds === null || durationSeconds > maxDurationHours * 3600)) return null;

        return {
          title: cleanEditionMarker(match.collectionName),
          author: match.artistName,
          reason: candidate.reason,
          description: match.description ?? null,
          durationSeconds,
          genre: match.primaryGenreName ?? null,
          coverUrl: match.artworkUrl100?.replace('100x100bb', '300x300bb') ?? null,
          storeUrl: match.collectionViewUrl ?? null,
        };
      } catch {
        // Verification is deliberately per candidate: transport failures,
        // timeouts, and malformed bodies drop one result without aborting the
        // rest of the recommendation response.
        return null;
      }
    },
  };
}
