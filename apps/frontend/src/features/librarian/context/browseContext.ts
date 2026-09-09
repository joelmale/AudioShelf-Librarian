import type { BestsellerSource, BestsellerBook } from "../components/BestsellerLists.js";
import type { Book, RecommendationResult } from "../../curator/api.js";

const BESTSELLERS_SNAPSHOT_KEY = "audioshelf_bestsellers_snapshot";
const RECOMMENDATIONS_SNAPSHOT_KEY = "audioshelf_recommendations_snapshot";
const BOOK_LIST_SNAPSHOT_KEY = "audioshelf_book_list_snapshot";

export interface BestsellersSnapshot {
  lists: Partial<Record<BestsellerSource, BestsellerBook[]>>;
  activeTab?: string;
  selectedAnchor?: string;
  timestamp: number;
}

export interface RecommendationsSnapshot {
  prompt: string;
  seeds: Book[];
  result: RecommendationResult;
  timestamp: number;
}

export interface BookListSnapshot {
  search: string;
  category: string;
  tag: string;
  untagged: boolean;
  page: number;
}

// In-memory fallback if sessionStorage is inaccessible
const memoryStorage = new Map<string, string>();

function getItem(key: string): string | null {
  try {
    if (typeof window !== "undefined" && window.sessionStorage) {
      return window.sessionStorage.getItem(key);
    }
  } catch {
    // Fallback to memory
  }
  return memoryStorage.get(key) ?? null;
}

function setItem(key: string, value: string): void {
  try {
    if (typeof window !== "undefined" && window.sessionStorage) {
      window.sessionStorage.setItem(key, value);
      return;
    }
  } catch {
    // Fallback to memory
  }
  memoryStorage.set(key, value);
}

function removeItem(key: string): void {
  try {
    if (typeof window !== "undefined" && window.sessionStorage) {
      window.sessionStorage.removeItem(key);
    }
  } catch {
    // Fallback to memory
  }
  memoryStorage.delete(key);
}

export const browseContext = {
  getBestsellersSnapshot(): BestsellersSnapshot | null {
    const raw = getItem(BESTSELLERS_SNAPSHOT_KEY);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as BestsellersSnapshot;
    } catch {
      removeItem(BESTSELLERS_SNAPSHOT_KEY);
      return null;
    }
  },

  setBestsellersSnapshot(snapshot: BestsellersSnapshot): void {
    setItem(BESTSELLERS_SNAPSHOT_KEY, JSON.stringify(snapshot));
  },

  clearBestsellersSnapshot(): void {
    removeItem(BESTSELLERS_SNAPSHOT_KEY);
  },

  getRecommendationsSnapshot(): RecommendationsSnapshot | null {
    const raw = getItem(RECOMMENDATIONS_SNAPSHOT_KEY);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as RecommendationsSnapshot;
    } catch {
      removeItem(RECOMMENDATIONS_SNAPSHOT_KEY);
      return null;
    }
  },

  setRecommendationsSnapshot(snapshot: RecommendationsSnapshot): void {
    setItem(RECOMMENDATIONS_SNAPSHOT_KEY, JSON.stringify(snapshot));
  },

  clearRecommendationsSnapshot(): void {
    removeItem(RECOMMENDATIONS_SNAPSHOT_KEY);
  },

  getBookListSnapshot(): BookListSnapshot | null {
    const raw = getItem(BOOK_LIST_SNAPSHOT_KEY);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as BookListSnapshot;
    } catch {
      removeItem(BOOK_LIST_SNAPSHOT_KEY);
      return null;
    }
  },

  setBookListSnapshot(snapshot: BookListSnapshot): void {
    setItem(BOOK_LIST_SNAPSHOT_KEY, JSON.stringify(snapshot));
  },

  clearBookListSnapshot(): void {
    removeItem(BOOK_LIST_SNAPSHOT_KEY);
  },
};
