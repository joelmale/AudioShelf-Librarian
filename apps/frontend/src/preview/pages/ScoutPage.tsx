import { BestsellerLists } from "../../features/librarian/components/BestsellerLists.js";
import { AudiobookSearch } from "../../features/librarian/components/AudiobookSearch.js";

export function ScoutPage({ mode }: { mode: "trends" | "search" }) {
  return <div className="v2-page v2-legacy-surface">
    <div className="v2-page-heading"><div><span className="v2-eyebrow">Scout & acquire</span><h1>{mode === "trends" ? "Trend intelligence" : "Search acquisition sources"}</h1><p>{mode === "trends" ? "Explore external signals, then investigate a promising title." : "Search AudiobookBay and send an approved candidate to qBittorrent."}</p></div><span className="v2-live"><span className="v2-dot ok"/> Live actions</span></div>
    {mode === "trends" ? <><BestsellerLists/><div className="v2-section-divider"><span>Search a candidate</span></div><AudiobookSearch/></> : <AudiobookSearch/>}
  </div>;
}
