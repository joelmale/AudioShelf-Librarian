import { BestsellerLists } from "../../features/librarian/components/BestsellerLists.js";
import { AudiobookSearch } from "../../features/librarian/components/AudiobookSearch.js";
import { RecommendationFinder } from "../../features/librarian/components/RecommendationFinder.js";
import { IntakePanel } from "../components/IntakePanel.js";
import { SavedCandidatesView } from "../components/SavedCandidatesView.js";
import { NavLink } from "react-router-dom";
import { BookmarkCheck, FolderCog, Search, Sparkles } from "lucide-react";

export function ScoutPage({ mode }: { mode: "trends" | "search" | "recommendations" | "intake" | "saved" }) {
  return <div className="v2-page v2-legacy-surface">
    <div className="v2-page-heading"><div><span className="v2-eyebrow">Discover</span><h1>{mode === "trends" ? "Find what belongs next" : mode === "recommendations" ? "Find what to add next" : mode === "intake" ? "Review intake conflicts" : mode === "saved" ? "Review triaged candidates" : "Search acquisition sources"}</h1><p>{mode === "trends" ? "Explore external signals, then investigate and acquire a promising title in one workflow." : mode === "recommendations" ? "Suggestions for books you do not own yet, each verified against a store listing. For what is already on your shelf, ask the librarian." : mode === "intake" ? "New files are shelved automatically. Only duplicates, ambiguous matches and errors land here for a decision." : mode === "saved" ? "Durable Want, Later, and Pass decisions that survive restarts and stay available even if removed upstream." : "Search AudiobookBay and send an approved candidate to qBittorrent."}</p></div>{mode === "intake" ? <span className="v2-live warning"><span className="v2-dot warn"/> Live filesystem</span> : <span className="v2-live"><span className="v2-dot ok"/> Live actions</span>}</div>
    <nav className="v2-section-tabs" aria-label="Discover sections">
      <NavLink to="/discover/charts" className={({ isActive }) => isActive ? "active" : ""}><Sparkles/><span>Charts</span></NavLink>
      <NavLink to="/discover/for-you" className={({ isActive }) => isActive ? "active" : ""}><Sparkles/><span>For you</span></NavLink>
      <NavLink to="/discover/saved" className={({ isActive }) => isActive ? "active" : ""}><BookmarkCheck/><span>Saved</span></NavLink>
      <NavLink to="/discover/search" className={({ isActive }) => isActive ? "active" : ""}><Search/><span>Search sources</span></NavLink>
      <NavLink to="/scout/intake" className={({ isActive }) => isActive ? "active" : ""}><FolderCog/><span>Intake review</span></NavLink>
    </nav>
    {mode === "trends" ? <BestsellerLists/> : mode === "recommendations" ? <RecommendationFinder/> : mode === "intake" ? <IntakePanel/> : mode === "saved" ? <SavedCandidatesView/> : <AudiobookSearch/>}
  </div>;
}
