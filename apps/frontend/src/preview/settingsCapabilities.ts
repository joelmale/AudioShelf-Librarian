export interface ServerDirectory {
  currentPath: string;
  parentPath: string | null;
  directories: string[];
}

export interface IntegrationStatus {
  audiobookbay: {
    activeDomain: string | null;
    lastScrapeTime: string | null;
    knownMirrors: number;
  };
  qbittorrent: {
    connected: boolean;
    activeDownloads: number;
    completedTorrents: number;
    importedTorrents: number;
  };
  audiobookshelf: {
    connected: boolean;
    libraries: number;
    books: number;
  };
  proxy: {
    enabled: boolean;
    working: boolean;
    ip: string | null;
    location: string | null;
  };
}

type Requester = (input: string, init?: RequestInit) => Promise<Response>;

async function readJson<T>(
  url: string,
  request: Requester,
): Promise<T> {
  const response = await request(url);
  const payload = await response.json().catch(() => ({})) as {
    success?: boolean;
    data?: T;
    error?: string;
  };
  if (!response.ok || payload.success !== true || payload.data === undefined) {
    throw new Error(payload.error || `Request failed (${response.status})`);
  }
  return payload.data;
}

export function loadServerDirectory(
  path: string,
  request: Requester = fetch,
): Promise<ServerDirectory> {
  return request(`/api/system/fs?path=${encodeURIComponent(path || "/")}`).then(async (response) => {
    const payload = await response.json().catch(() => ({})) as Partial<ServerDirectory> & {
      success?: boolean;
      error?: string;
    };
    if (!response.ok || payload.success !== true || typeof payload.currentPath !== "string" || !Array.isArray(payload.directories)) {
      throw new Error(payload.error || `Request failed (${response.status})`);
    }
    return {
      currentPath: payload.currentPath,
      parentPath: typeof payload.parentPath === "string" ? payload.parentPath : null,
      directories: payload.directories,
    };
  });
}

export function loadIntegrationStatus(
  request: Requester = fetch,
): Promise<IntegrationStatus> {
  return readJson("/api/librarian/status", request);
}
