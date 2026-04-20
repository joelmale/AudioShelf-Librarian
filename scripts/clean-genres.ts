import axios, { AxiosError } from "axios";

type AnchorGenre =
  | "Action & Adventure"
  | "Biographies & Memoirs"
  | "Business & Leadership"
  | "Children & YA"
  | "Classics"
  | "Comedy"
  | "Fantasy"
  | "History & Politics"
  | "Literature & Fiction"
  | "Mystery"
  | "Non-Fiction"
  | "Romance"
  | "Science Fiction"
  | "Thriller & Suspense";

interface ABSBook {
  id: string;
  media: {
    metadata: {
      title?: string;
      genres?: string[];
    };
  };
}

interface ABSLibraryItemsResponse {
  results: ABSBook[];
  total: number;
}

interface ABSApiError {
  error?: string;
  message?: string;
  detail?: string;
}

interface CleanupPreview {
  id: string;
  title: string;
  before: string[];
  after: string[];
}

const genreMapping: Record<string, AnchorGenre> = {
  Action: "Action & Adventure",
  Adventure: "Action & Adventure",
  "Action & Adventure": "Action & Adventure",
  "Biographies & Memoirs": "Biographies & Memoirs",
  Biography: "Biographies & Memoirs",
  Biographies: "Biographies & Memoirs",
  Memoir: "Biographies & Memoirs",
  Memoirs: "Biographies & Memoirs",
  Business: "Business & Leadership",
  "Business & Leadership": "Business & Leadership",
  "Children & YA": "Children & YA",
  "Children's Audiobooks": "Children & YA",
  Epic: "Fantasy",
  Fantasy: "Fantasy",
  "Fantasy fiction": "Fantasy",
  "Sword & Sorcery": "Fantasy",
  Dragons: "Fantasy",
  Drizzt: "Fantasy",
  "Science Fiction": "Science Fiction",
  "Science Fiction & Fantasy": "Science Fiction",
  "Hard Science Fiction": "Science Fiction",
  "Space Opera": "Science Fiction",
  "Post-Apocalyptic": "Science Fiction",
  Dystopian: "Science Fiction",
  Robots: "Science Fiction",
  "Sci-Fi": "Science Fiction",
  "Amateur Sleuths": "Mystery",
  Cozy: "Mystery",
  "Women Sleuths": "Mystery",
  "Police Procedurals": "Mystery",
  Mystery: "Mystery",
  "Crime Thrillers": "Thriller & Suspense",
  Psychological: "Thriller & Suspense",
  Suspense: "Thriller & Suspense",
  "Thriller & Suspense": "Thriller & Suspense",
  "Domestic Thrillers": "Thriller & Suspense",
  Fiction: "Literature & Fiction",
  Contemporary: "Literature & Fiction",
  "Women's Fiction": "Literature & Fiction",
  "Literary Fiction": "Literature & Fiction",
  "Literature & Fiction": "Literature & Fiction",
  "Family Life": "Literature & Fiction",
  Humorous: "Comedy",
  "Humor (Fiction)": "Comedy",
  Comedy: "Comedy",
  Classic: "Classics",
  Classics: "Classics",
  Nonfiction: "Non-Fiction",
  "Non-Fiction": "Non-Fiction",
  Romance: "Romance",
  "History & Politics": "History & Politics",
  Historical: "History & Politics",
  Presidents: "History & Politics",
  "American Civil War": "History & Politics",
  "World War II": "History & Politics",
  Military: "History & Politics",
  Politicians: "History & Politics",
  Leadership: "Business & Leadership",
  Management: "Business & Leadership",
  Juvenile: "Children & YA",
  Teen: "Children & YA",
  "Young Adult": "Children & YA",
};

const discardList = [
  "Abandonment of automobiles",
  "Waitresses",
  "Berwickshire",
  "Clocks and watches",
  "Hugo Award",
  "Nebula Award",
  "Locus Award",
  "Graphic Audio",
  "Other",
  "Speech",
];

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function hasFlag(flag: string): boolean {
  return process.argv.includes(flag);
}

function sortGenres(genres: string[]): string[] {
  return [...genres].sort((a, b) => a.localeCompare(b));
}

function genresEqual(left: string[], right: string[]): boolean {
  return JSON.stringify(sortGenres(left)) === JSON.stringify(sortGenres(right));
}

function cleanGenres(originalGenres: string[], keepUnmapped: boolean): string[] {
  const newGenreSet = new Set<string>();

  for (const rawGenre of originalGenres) {
    const splitGenres = rawGenre
      .split(",")
      .map((genre) => genre.trim())
      .filter((genre) => genre.length > 0);

    for (const genre of splitGenres) {
      const normalizedGenre = genre.toLowerCase();

      if (
        discardList.some((discard) =>
          normalizedGenre.includes(discard.toLowerCase()),
        )
      ) {
        continue;
      }

      let matched = false;
      for (const [messy, clean] of Object.entries(genreMapping)) {
        if (normalizedGenre.includes(messy.toLowerCase())) {
          newGenreSet.add(clean);
          matched = true;
        }
      }

      if (!matched && keepUnmapped) {
        newGenreSet.add(genre);
      }
    }
  }

  return sortGenres(Array.from(newGenreSet));
}

function describeAxiosError(error: AxiosError<ABSApiError>): string {
  const status = error.response?.status;
  const data = error.response?.data;
  const detail = data?.detail ?? data?.message ?? data?.error ?? error.message;
  return status ? `HTTP ${status}: ${detail}` : error.message;
}

async function cleanLibraryGenres(): Promise<void> {
  const absUrl = requireEnv("ABS_URL");
  const apiToken = requireEnv("ABS_API_TOKEN");
  const libraryId = requireEnv("ABS_LIBRARY_ID");
  const writeChanges = hasFlag("--write");
  const keepUnmapped = !hasFlag("--drop-unmapped");

  const apiClient = axios.create({
    baseURL: absUrl,
    headers: { Authorization: `Bearer ${apiToken}` },
    timeout: 30_000,
  });

  console.log(
    writeChanges
      ? "Write mode enabled. Matching genre changes will be applied."
      : "Dry run enabled. Pass --write to apply changes.",
  );
  console.log(
    keepUnmapped
      ? "Unmapped genres will be kept."
      : "Unmapped genres will be dropped.",
  );

  const response = await apiClient.get<ABSLibraryItemsResponse>(
    `/api/libraries/${libraryId}/items?limit=0`,
  );

  const changedBooks: CleanupPreview[] = [];

  for (const book of response.data.results) {
    const originalGenres = book.media.metadata.genres ?? [];
    const updatedGenres = cleanGenres(originalGenres, keepUnmapped);

    if (!genresEqual(originalGenres, updatedGenres)) {
      changedBooks.push({
        id: book.id,
        title: book.media.metadata.title ?? book.id,
        before: originalGenres,
        after: updatedGenres,
      });
    }
  }

  console.log(
    `Found ${changedBooks.length} items with genre changes out of ${response.data.results.length} items.`,
  );

  for (const change of changedBooks) {
    console.log(`\n${change.title}`);
    console.log(`  Before: ${change.before.join(" | ") || "(none)"}`);
    console.log(`  After:  ${change.after.join(" | ") || "(none)"}`);

    if (writeChanges) {
      try {
        await apiClient.patch(`/api/items/${change.id}/media`, {
          metadata: {
            genres: change.after,
          },
        });
        console.log("  Updated");
      } catch (error: unknown) {
        if (axios.isAxiosError<ABSApiError>(error)) {
          console.error(`  Failed: ${describeAxiosError(error)}`);
        } else if (error instanceof Error) {
          console.error(`  Failed: ${error.message}`);
        } else {
          console.error("  Failed: Unknown error");
        }
      }
    }
  }

  console.log(writeChanges ? "\nCleanup complete." : "\nDry run complete.");
}

cleanLibraryGenres().catch((error: unknown) => {
  if (axios.isAxiosError<ABSApiError>(error)) {
    console.error(describeAxiosError(error));
  } else if (error instanceof Error) {
    console.error(error.message);
  } else {
    console.error("Unknown error");
  }
  process.exitCode = 1;
});
