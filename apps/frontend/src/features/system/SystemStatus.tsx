import React, { useEffect, useState } from "react";

interface StatusData {
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
}

export const SystemStatus: React.FC = () => {
  const [data, setData] = useState<StatusData | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fetchStatus = async () => {
    try {
      const res = await fetch("/api/librarian/status");
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Failed to fetch status");
      setData(json.data);
      setError(null);
    } catch (err: any) {
      setError(err.message);
    }
  };

  useEffect(() => {
    fetchStatus();
    const interval = setInterval(fetchStatus, 30000); // Refresh every 30s
    return () => clearInterval(interval);
  }, []);

  const renderIndicator = (isGood: boolean) => (
    <span style={{
      display: 'inline-block',
      width: '12px',
      height: '12px',
      borderRadius: '50%',
      backgroundColor: isGood ? 'var(--secondary-accent)' : 'var(--red)',
      marginRight: '8px',
      boxShadow: `0 0 8px ${isGood ? 'var(--secondary-glow)' : 'rgba(242, 139, 130, 0.4)'}`
    }} />
  );

  return (
    <div style={{ padding: '30px', maxWidth: '1000px', margin: '0 auto', color: 'var(--text-primary)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '32px' }}>
        <h1 style={{ margin: 0, fontSize: '2rem', fontWeight: 800 }}>System Health</h1>
        <button onClick={fetchStatus} className="glass-button">
          Refresh Stats
        </button>
      </div>

      {error && (
        <div style={{ background: 'rgba(242, 139, 130, 0.2)', padding: '16px', borderRadius: '8px', color: 'var(--red)', marginBottom: '24px' }}>
          {error}
        </div>
      )}

      {data ? (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: '24px' }}>
          
          {/* AudiobookBay Card */}
          <div className="glass-panel" style={{ padding: '24px' }}>
            <h2 style={{ fontSize: '1.25rem', marginTop: 0, marginBottom: '20px', display: 'flex', alignItems: 'center' }}>
              {renderIndicator(!!data.audiobookbay.activeDomain)}
              AudiobookBay Network
            </h2>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              <div>
                <span style={{ color: 'var(--text-secondary)' }}>Status:</span>{' '}
                <strong>{data.audiobookbay.activeDomain ? "Online" : "Resolving"}</strong>
              </div>
              <div>
                <span style={{ color: 'var(--text-secondary)' }}>Active Mirror:</span>{' '}
                <span style={{ wordBreak: 'break-all' }}>{data.audiobookbay.activeDomain || "None"}</span>
              </div>
              <div>
                <span style={{ color: 'var(--text-secondary)' }}>Known Proxies:</span>{' '}
                <strong>{data.audiobookbay.knownMirrors}</strong>
              </div>
              <div>
                <span style={{ color: 'var(--text-secondary)' }}>Last Scrape:</span>{' '}
                {data.audiobookbay.lastScrapeTime ? new Date(data.audiobookbay.lastScrapeTime).toLocaleString() : "Never"}
              </div>
            </div>
          </div>

          {/* qBittorrent Card */}
          <div className="glass-panel" style={{ padding: '24px' }}>
            <h2 style={{ fontSize: '1.25rem', marginTop: 0, marginBottom: '20px', display: 'flex', alignItems: 'center' }}>
              {renderIndicator(data.qbittorrent.connected)}
              qBittorrent Monitor
            </h2>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              <div>
                <span style={{ color: 'var(--text-secondary)' }}>Connection:</span>{' '}
                <strong>{data.qbittorrent.connected ? "Connected" : "Offline"}</strong>
              </div>
              <div>
                <span style={{ color: 'var(--text-secondary)' }}>Active Downloads:</span>{' '}
                <strong>{data.qbittorrent.activeDownloads}</strong>
              </div>
              <div>
                <span style={{ color: 'var(--text-secondary)' }}>Completed Audiobooks:</span>{' '}
                <strong>{data.qbittorrent.completedTorrents}</strong>
              </div>
              <div>
                <span style={{ color: 'var(--text-secondary)' }}>Auto-Imported:</span>{' '}
                <strong>{data.qbittorrent.importedTorrents}</strong>
              </div>
            </div>
          </div>

          {/* AudioBookshelf Card */}
          <div className="glass-panel" style={{ padding: '24px' }}>
            <h2 style={{ fontSize: '1.25rem', marginTop: 0, marginBottom: '20px', display: 'flex', alignItems: 'center' }}>
              {renderIndicator(data.audiobookshelf.connected)}
              AudioBookshelf (ABS)
            </h2>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              <div>
                <span style={{ color: 'var(--text-secondary)' }}>Connection:</span>{' '}
                <strong>{data.audiobookshelf.connected ? "Connected" : "Offline"}</strong>
              </div>
              <div>
                <span style={{ color: 'var(--text-secondary)' }}>Libraries:</span>{' '}
                <strong>{data.audiobookshelf.libraries}</strong>
              </div>
              <div>
                <span style={{ color: 'var(--text-secondary)' }}>Total Books:</span>{' '}
                <strong>{data.audiobookshelf.books}</strong>
              </div>
              {!data.audiobookshelf.connected && (
                <div>
                  <span style={{ fontSize: '0.9rem', color: 'var(--text-secondary)' }}>
                    Active library polling requires ABS_URL and ABS_TOKEN to be configured in your environment variables.
                  </span>
                </div>
              )}
            </div>
          </div>

        </div>
      ) : (
        <div style={{ textAlign: 'center', padding: '40px', color: 'var(--text-secondary)' }}>
          {!error && "Loading system stats..."}
        </div>
      )}
    </div>
  );
};
