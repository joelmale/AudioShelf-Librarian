import { useMemo, useState } from 'react';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
  Legend,
} from 'recharts';
import WordCloud from 'react-d3-cloud';

import { useVocabulary } from '../api';
import { ExpandableChart } from './ExpandableChart';

const BASE_HUES: Record<string, number> = {
  genre: 236, // Indigo
  mood: 160, // Emerald
  theme: 38, // Amber
  era: 240, // Indigo light
  pacing: 258, // Violet
  length: 330, // Pink
  audience: 217, // Blue
};

function getDynamicColors(hueShift: number) {
  const colors: Record<string, string> = {};
  for (const [category, baseHue] of Object.entries(BASE_HUES)) {
    colors[category] = `hsl(${(baseHue + hueShift) % 360}, 80%, 55%)`;
  }
  return colors;
}

export function TagAnalytics() {
  const { data: vocab = [], isLoading } = useVocabulary();
  const [hueShift, setHueShift] = useState(0);

  const colors = useMemo(() => getDynamicColors(hueShift), [hueShift]);

  const { topTags, wordCloudData, categoryData, topGenres, topMoodsThemes } = useMemo(() => {
    // Sort all tags by count descending
    const sorted = [...vocab].sort((a, b) => b.count - a.count);

    // 1. Top 25 Tags (Bar Chart)
    const topTags = sorted.slice(0, 25);

    // 2. Word Cloud Data (Top 100)
    // react-d3-cloud expects { text, value }
    const wordCloudData = sorted.slice(0, 100).map((t) => ({
      text: t.tag,
      value: t.count,
      category: t.category,
    }));

    // 3. Category Distribution (Pie Chart)
    const categoryCounts: Record<string, number> = {};
    sorted.forEach((t) => {
      categoryCounts[t.category] = (categoryCounts[t.category] || 0) + t.count;
    });
    const categoryData = Object.entries(categoryCounts).map(([name, value]) => ({
      name,
      value,
    })).sort((a, b) => b.value - a.value);

    // 4. Top 10 Genres
    const topGenres = sorted.filter((t) => t.category === 'genre').slice(0, 10);

    // 5. Top 10 Moods & Themes
    const topMoodsThemes = sorted
      .filter((t) => t.category === 'mood' || t.category === 'theme')
      .slice(0, 10);

    return { topTags, wordCloudData, categoryData, topGenres, topMoodsThemes };
  }, [vocab]);

  if (isLoading) {
    return <div className="muted" style={{ padding: '20px 0' }}>Loading analytics...</div>;
  }

  if (vocab.length === 0) {
    return null;
  }

  // Word cloud callbacks
  const fontSize = (word: any) => Math.max(12, Math.log2(Math.max(1, word.value || 1)) * 10 + 10);
  const fill = (word: any) => colors[word.category] || '#999';

  return (
    <div style={{ marginTop: '32px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '16px' }}>
        <h2 style={{ margin: 0 }}>Library Tags Overview</h2>
        <div style={{ display: 'flex', alignItems: 'center', gap: '16px', background: 'var(--bg-card)', padding: '8px 16px', borderRadius: '8px', border: '1px solid var(--border)' }}>
          <label style={{ fontWeight: '500', fontSize: '0.9rem' }}>Color Dial</label>
          <input 
            type="range" 
            min="0" 
            max="360" 
            value={hueShift} 
            onChange={(e) => setHueShift(Number(e.target.value))}
            style={{ width: '150px', cursor: 'grab', accentColor: `hsl(${hueShift}, 80%, 55%)` }}
          />
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '24px', marginBottom: '24px' }}>
        {/* Word Cloud */}
        <div style={{ gridColumn: '1 / -1' }}>
          <ExpandableChart title="Top 100 Tags Word Cloud" previewHeight={350}>
            {(isExpanded) => (
              <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <WordCloud
                  data={wordCloudData}
                  width={isExpanded ? window.innerWidth * 0.8 : 800}
                  height={isExpanded ? window.innerHeight * 0.7 : 350}
                  fontSize={fontSize}
                  rotate={() => 0}
                  padding={2}
                  fill={(d: any) => colors[d?.category] || '#999'}
                />
              </div>
            )}
          </ExpandableChart>
        </div>

        {/* Top 25 Tags */}
        <div style={{ gridColumn: '1 / -1' }}>
          <ExpandableChart title="Top 25 Tags Overall" previewHeight={200}>
            {(isExpanded) => (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={topTags} margin={{ top: 10, right: 10, left: 0, bottom: 20 }}>
                  <CartesianGrid strokeDasharray="3 3" opacity={0.2} />
                  <XAxis dataKey="tag" angle={-45} textAnchor="end" height={isExpanded ? 100 : 60} tick={{ fontSize: 12 }} interval={0} />
                  <YAxis width={40} />
                  <Tooltip 
                    contentStyle={{ backgroundColor: 'var(--bg)', borderColor: 'var(--border)' }}
                    formatter={(value: any) => [value, 'Books']}
                  />
                  <Bar dataKey="count" fill="var(--accent)" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </ExpandableChart>
        </div>

        {/* Category Breakdown */}
        <ExpandableChart title="Tags by Category" previewHeight={200}>
          {(isExpanded) => (
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={categoryData}
                  cx="50%"
                  cy="50%"
                  innerRadius={isExpanded ? 100 : 40}
                  outerRadius={isExpanded ? 180 : 70}
                  paddingAngle={2}
                  dataKey="value"
                >
                  {categoryData.map((entry, index) => (
                    <Cell key={`cell-${index}`} fill={colors[entry.name] || '#999'} />
                  ))}
                </Pie>
                <Tooltip contentStyle={{ backgroundColor: 'var(--bg)', borderColor: 'var(--border)' }} />
                <Legend />
              </PieChart>
            </ResponsiveContainer>
          )}
        </ExpandableChart>

        {/* Top Genres */}
        <ExpandableChart title="Top 10 Genres" previewHeight={200}>
          {(isExpanded) => (
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={topGenres} layout="vertical" margin={{ top: 10, right: 10, left: isExpanded ? 60 : 30, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" opacity={0.2} />
                <XAxis type="number" hide={!isExpanded} />
                <YAxis type="category" dataKey="tag" width={100} tick={{ fontSize: 12 }} interval={0} />
                <Tooltip 
                  contentStyle={{ backgroundColor: 'var(--bg)', borderColor: 'var(--border)' }}
                  formatter={(value: any) => [value, 'Books']}
                />
                <Bar dataKey="count" fill={colors.genre} radius={[0, 4, 4, 0]} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </ExpandableChart>

        {/* Top Moods & Themes */}
        <div style={{ gridColumn: '1 / -1' }}>
          <ExpandableChart title="Top 10 Moods & Themes" previewHeight={200}>
            {(isExpanded) => (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={topMoodsThemes} margin={{ top: 10, right: 10, left: 0, bottom: 20 }}>
                  <CartesianGrid strokeDasharray="3 3" opacity={0.2} />
                  <XAxis dataKey="tag" angle={-45} textAnchor="end" height={isExpanded ? 100 : 60} tick={{ fontSize: 12 }} interval={0} />
                  <YAxis width={40} />
                  <Tooltip 
                    contentStyle={{ backgroundColor: 'var(--bg)', borderColor: 'var(--border)' }}
                    formatter={(value: any) => [value, 'Books']}
                  />
                  <Bar dataKey="count" radius={[4, 4, 0, 0]}>
                    {topMoodsThemes.map((entry, index) => (
                      <Cell key={`cell-${index}`} fill={colors[entry.category] || 'var(--accent)'} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            )}
          </ExpandableChart>
        </div>
      </div>
    </div>
  );
}
