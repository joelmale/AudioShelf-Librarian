import { useMemo, useState } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { useVocabulary } from '../api';

const BASE_HUES: Record<string, number> = {
  genre: 236,
  mood: 160,
  theme: 38,
  era: 240,
  pacing: 258,
  length: 330,
  audience: 217,
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
  const [activeTab, setActiveTab] = useState<'wordcloud' | 'toptags' | 'categories' | 'genres' | 'moods'>('wordcloud');

  const colors = useMemo(() => getDynamicColors(hueShift), [hueShift]);

  const { topTags, wordCloudData, categoryData, topGenres, topMoodsThemes } = useMemo(() => {
    const sorted = [...vocab].sort((a, b) => b.count - a.count);
    const topTags = sorted.slice(0, 25);
    const wordCloudData = sorted.slice(0, 150).map((t) => ({
      text: t.tag,
      value: t.count,
      category: t.category,
    }));
    const categoryCounts: Record<string, number> = {};
    sorted.forEach((t) => {
      categoryCounts[t.category] = (categoryCounts[t.category] || 0) + t.count;
    });
    const categoryData = Object.entries(categoryCounts).map(([name, value]) => ({
      name,
      value,
    })).sort((a, b) => b.value - a.value);
    const topGenres = sorted.filter((t) => t.category === 'genre').slice(0, 10);
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

  const maxCount = Math.max(1, ...wordCloudData.map(d => d.value));
  const fontSize = (word: { value: number }) => {
    const minSize = 12;
    const maxSize = 50;
    // Use square root for better distribution of font sizes
    const ratio = Math.sqrt(word.value) / Math.sqrt(maxCount);
    return minSize + (ratio * (maxSize - minSize));
  };

  const tabs = [
    { id: 'wordcloud', label: 'Word Cloud' },
    { id: 'toptags', label: 'Top 25 Tags' },
    { id: 'categories', label: 'Categories' },
    { id: 'genres', label: 'Top Genres' },
    { id: 'moods', label: 'Moods & Themes' }
  ] as const;

  return (
    <div style={{ marginTop: '32px' }} className="card">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '24px' }}>
        <h2 style={{ margin: 0 }}>Library Tags Analytics</h2>
        <div style={{ display: 'flex', alignItems: 'center', gap: '16px', background: 'var(--bg-2)', padding: '6px 12px', borderRadius: '8px' }}>
          <label style={{ fontWeight: '500', fontSize: '0.85rem' }}>Color Dial</label>
          <input 
            type="range" 
            min="0" 
            max="360" 
            value={hueShift} 
            onChange={(e) => setHueShift(Number(e.target.value))}
            style={{ width: '120px', cursor: 'grab', accentColor: `hsl(${hueShift}, 80%, 55%)` }}
          />
        </div>
      </div>

      <div style={{ display: 'flex', gap: '8px', borderBottom: '1px solid var(--border)', paddingBottom: '12px', marginBottom: '24px' }}>
        {tabs.map(tab => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            style={{
              padding: '8px 16px',
              borderRadius: '8px',
              border: 'none',
              background: activeTab === tab.id ? 'var(--accent)' : 'transparent',
              color: activeTab === tab.id ? '#fff' : 'var(--text-dim)',
              fontWeight: 600,
              fontSize: '13px',
              cursor: 'pointer',
              transition: 'all 0.2s'
            }}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div style={{ height: '400px', width: '100%', position: 'relative' }}>
        {activeTab === 'wordcloud' && (
          <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <div aria-label="Tag word cloud" style={{display:'flex',flexWrap:'wrap',alignItems:'center',justifyContent:'center',alignContent:'center',gap:'8px 14px',maxWidth:'900px',padding:'24px'}}>
              {wordCloudData.map(word=><span key={`${word.category}:${word.text}`} title={`${word.text}: ${word.value} books`} style={{fontSize:`${fontSize(word)}px`,lineHeight:1,color:colors[word.category]||'#4f46e5',fontWeight:600}}>{word.text}</span>)}
            </div>
          </div>
        )}

        {activeTab === 'toptags' && (
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={topTags} margin={{ top: 10, right: 10, left: 0, bottom: 60 }}>
              <CartesianGrid strokeDasharray="3 3" opacity={0.2} />
              <XAxis dataKey="tag" angle={-45} textAnchor="end" height={80} tick={{ fontSize: 12 }} interval={0} />
              <YAxis width={40} />
              <Tooltip 
                contentStyle={{ backgroundColor: 'var(--panel)', borderColor: 'var(--border)' }}
                formatter={(value: any) => [value, 'Books']}
              />
              <Bar dataKey="count" fill="var(--accent)" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        )}

        {activeTab === 'categories' && (
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie
                data={categoryData}
                cx="50%"
                cy="50%"
                innerRadius={80}
                outerRadius={140}
                paddingAngle={2}
                dataKey="value"
              >
                {categoryData.map((entry, index) => (
                  <Cell key={`cell-${index}`} fill={colors[entry.name] || '#999'} />
                ))}
              </Pie>
              <Tooltip contentStyle={{ backgroundColor: 'var(--panel)', borderColor: 'var(--border)' }} />
              <Legend />
            </PieChart>
          </ResponsiveContainer>
        )}

        {activeTab === 'genres' && (
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={topGenres} layout="vertical" margin={{ top: 10, right: 30, left: 100, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" opacity={0.2} />
              <XAxis type="number" />
              <YAxis type="category" dataKey="tag" width={120} tick={{ fontSize: 12 }} interval={0} />
              <Tooltip 
                contentStyle={{ backgroundColor: 'var(--panel)', borderColor: 'var(--border)' }}
                formatter={(value: any) => [value, 'Books']}
              />
              <Bar dataKey="count" fill={colors.genre} radius={[0, 4, 4, 0]} />
            </BarChart>
          </ResponsiveContainer>
        )}

        {activeTab === 'moods' && (
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={topMoodsThemes} margin={{ top: 10, right: 10, left: 0, bottom: 60 }}>
              <CartesianGrid strokeDasharray="3 3" opacity={0.2} />
              <XAxis dataKey="tag" angle={-45} textAnchor="end" height={80} tick={{ fontSize: 12 }} interval={0} />
              <YAxis width={40} />
              <Tooltip 
                contentStyle={{ backgroundColor: 'var(--panel)', borderColor: 'var(--border)' }}
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
      </div>
    </div>
  );
}
