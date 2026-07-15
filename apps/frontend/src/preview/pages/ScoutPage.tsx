import { BestsellerLists } from "../../features/librarian/components/BestsellerLists.js";
import { AudiobookSearch } from "../../features/librarian/components/AudiobookSearch.js";
import { RecommendationFinder } from "../../features/librarian/components/RecommendationFinder.js";
import { NavLink } from "react-router-dom";
import { Search, Sparkles } from "lucide-react";

export function ScoutPage({ mode }: { mode: "trends" | "search" | "recommendations" }) {
  return <div className="v2-page v2-legacy-surface">
    <div className="v2-page-heading"><div><span className="v2-eyebrow">Scout & Acquire</span><h1>{mode === "trends" ? "Find what belongs next" : mode === "recommendations" ? "Ask your recommendation librarian" : "Search acquisition sources"}</h1><p>{mode === "trends" ? "Explore external signals, then investigate and acquire a promising title in one workflow." : mode === "recommendations" ? "Combine your listening history with a plain-language request, then compare what is here with what could be acquired." : "Search AudiobookBay and send an approved candidate to qBittorrent."}</p></div><span className="v2-live"><span className="v2-dot ok"/> Live actions</span></div>
    <nav className="v2-section-tabs" aria-label="Scout and acquire sections">
      <NavLink to="/scout/trends" className={({ isActive }) => isActive ? "active" : ""}><Sparkles/><span>Trends & discovery</span></NavLink>
      <NavLink to="/scout/recommendations" className={({ isActive }) => isActive ? "active" : ""}><Sparkles/><span>Recommendations</span></NavLink>
      <NavLink to="/scout/search" className={({ isActive }) => isActive ? "active" : ""}><Search/><span>Search & download</span></NavLink>
    </nav>
    {mode === "trends" ? <><AudiobookSearch/><div className="v2-section-divider"><span>Top Bestsellers</span></div><BestsellerLists/></> : mode === "recommendations" ? <RecommendationFinder/> : <AudiobookSearch/>}
  </div>;
}
