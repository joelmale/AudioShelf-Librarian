import { BestsellerLists } from "../../features/librarian/components/BestsellerLists.js";
import { AudiobookSearch } from "../../features/librarian/components/AudiobookSearch.js";
import { RecommendationFinder } from "../../features/librarian/components/RecommendationFinder.js";
import { IntakePanel } from "../components/IntakePanel.js";
import { NavLink } from "react-router-dom";
import { FolderCog, Search, Sparkles } from "lucide-react";

export function ScoutPage({ mode }: { mode: "trends" | "search" | "recommendations" | "intake" }) {
  return <div className="v2-page v2-legacy-surface">
    <div className="v2-page-heading"><div><span className="v2-eyebrow">Scout & Acquire</span><h1>{mode === "trends" ? "Find what belongs next" : mode === "recommendations" ? "Find what to add next" : mode === "intake" ? "Review intake conflicts" : "Search acquisition sources"}</h1><p>{mode === "trends" ? "Explore external signals, then investigate and acquire a promising title in one workflow." : mode === "recommendations" ? "Suggestions for books you do not own yet, each verified against a store listing. For what is already on your shelf, ask the librarian on your desk." : mode === "intake" ? "New files are shelved automatically. Only duplicates, ambiguous matches and errors land here for a decision." : "Search AudiobookBay and send an approved candidate to qBittorrent."}</p></div>{mode === "intake" ? <span className="v2-live warning"><span className="v2-dot warn"/> Live filesystem</span> : <span className="v2-live"><span className="v2-dot ok"/> Live actions</span>}</div>
    <nav className="v2-section-tabs" aria-label="Scout and acquire sections">
      <NavLink to="/scout/trends" className={({ isActive }) => isActive ? "active" : ""}><Sparkles/><span>Trends & discovery</span></NavLink>
      <NavLink to="/scout/recommendations" className={({ isActive }) => isActive ? "active" : ""}><Sparkles/><span>Recommendations</span></NavLink>
      <NavLink to="/scout/search" className={({ isActive }) => isActive ? "active" : ""}><Search/><span>Search & download</span></NavLink>
      <NavLink to="/scout/intake" className={({ isActive }) => isActive ? "active" : ""}><FolderCog/><span>Intake review</span></NavLink>
    </nav>
    {mode === "trends" ? <><AudiobookSearch/><div className="v2-section-divider"><span>Top Bestsellers</span></div><BestsellerLists/></> : mode === "recommendations" ? <RecommendationFinder/> : mode === "intake" ? <IntakePanel/> : <AudiobookSearch/>}
  </div>;
}
