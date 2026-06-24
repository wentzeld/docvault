import React, { useState, useRef, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { apiClient, ApiError, type SearchResult } from '../api/client';

interface SearchBarProps {
  standalone?: boolean;
}

const DOC_TYPES = ['prd', 'research', 'design', 'architecture', 'notes'] as const;

export function SearchBar({ standalone = false }: SearchBarProps) {
  const [query, setQuery] = useState('');
  const [mode, setMode] = useState<'hybrid' | 'semantic' | 'keyword'>('hybrid');
  const [typeFilter, setTypeFilter] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);
  const [degraded, setDegraded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<'relevance' | 'created' | 'updated'>('relevance');
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('desc');
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const doSearch = useCallback(
    async (q: string, searchMode: string, type: string) => {
      if (!q.trim()) {
        setResults([]);
        setSearched(false);
        return;
      }

      setLoading(true);
      setError(null);
      try {
        const result = await apiClient.post<{
          data: SearchResult[];
          mode?: string;
        }>('/search', {
          q,
          mode: searchMode,
          limit: 20,
          ...(type ? { type } : {}),
        });
        setResults(result.data);
        setDegraded(result.mode !== undefined && result.mode !== searchMode);
        setSearched(true);
      } catch (err) {
        // Surface the real failure instead of pretending there are no results
        setResults([]);
        setSearched(true);
        if (err instanceof ApiError && err.status === 401) {
          setError('Your session has expired — please log in again to search.');
        } else if (err instanceof ApiError) {
          setError(`Search failed: ${err.detail}`);
        } else {
          setError('Search failed: could not reach the server.');
        }
      } finally {
        setLoading(false);
      }
    },
    []
  );

  const handleQueryChange = (q: string) => {
    setQuery(q);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      void doSearch(q, mode, typeFilter);
    }, 300);
  };

  const handleModeChange = (m: 'hybrid' | 'semantic' | 'keyword') => {
    setMode(m);
    if (query) void doSearch(query, m, typeFilter);
  };

  const handleTypeChange = (t: string) => {
    setTypeFilter(t);
    if (query) void doSearch(query, mode, t);
  };

  const handleSortClick = (key: 'relevance' | 'created' | 'updated') => {
    if (sortKey === key) {
      setSortOrder(sortOrder === 'desc' ? 'asc' : 'desc');
    } else {
      setSortKey(key);
      setSortOrder('desc');
    }
  };

  const sortedResults =
    sortKey === 'relevance'
      ? results
      : [...results].sort((a, b) => {
          const ta = new Date(sortKey === 'created' ? a.created : a.updated).getTime() || 0;
          const tb = new Date(sortKey === 'created' ? b.created : b.updated).getTime() || 0;
          return sortOrder === 'desc' ? tb - ta : ta - tb;
        });

  return (
    <div>
      {standalone && (
        <div className="page-header">
          <h1 className="page-title">Search</h1>
        </div>
      )}

      <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--color-border)' }}>
        <input
          className="input"
          placeholder="Search documents..."
          value={query}
          onChange={(e) => handleQueryChange(e.target.value)}
          autoFocus={standalone}
          aria-label="Search query"
        />

        <div className="flex gap-2 mt-2 items-center">
          <span className="text-sm text-muted">Mode:</span>
          {(['hybrid', 'semantic', 'keyword'] as const).map((m) => (
            <button
              key={m}
              className={`btn btn-sm ${mode === m ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => handleModeChange(m)}
            >
              {m}
            </button>
          ))}

          <span className="text-sm text-muted" style={{ marginLeft: 8 }}>Sort:</span>
          {(['relevance', 'created', 'updated'] as const).map((k) => (
            <button
              key={k}
              className={`btn btn-sm ${sortKey === k ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => handleSortClick(k)}
            >
              {k}
              {sortKey === k && k !== 'relevance' ? (sortOrder === 'desc' ? ' ↓' : ' ↑') : ''}
            </button>
          ))}

          <span className="text-sm text-muted" style={{ marginLeft: 8 }}>Type:</span>
          <select
            className="input"
            style={{ width: 'auto' }}
            value={typeFilter}
            onChange={(e) => handleTypeChange(e.target.value)}
          >
            <option value="">All</option>
            {DOC_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </div>

        {degraded && (
          <div
            style={{
              marginTop: 8,
              padding: '6px 10px',
              background: 'var(--color-warning-light)',
              color: 'var(--color-warning)',
              borderRadius: 'var(--radius-sm)',
              fontSize: 12,
            }}
          >
            ⚠️ Embedding worker unavailable — showing keyword results only
          </div>
        )}
      </div>

      {/* Results */}
      <div>
        {loading && (
          <div className="p-4 text-muted">Searching...</div>
        )}

        {error && !loading && (
          <div
            role="alert"
            style={{
              margin: '8px 20px',
              padding: '8px 12px',
              background: 'var(--color-danger-light, #fdecea)',
              color: 'var(--color-danger, #b3261e)',
              borderRadius: 'var(--radius-sm, 6px)',
              fontSize: 13,
            }}
          >
            ⚠️ {error}
          </div>
        )}

        {!loading && searched && !error && results.length === 0 && (
          <div className="p-4 text-muted">No results found.</div>
        )}

        {sortedResults.map((result) => (
          <Link
            key={result.id}
            to={`/docs/${result.id}`}
            className="search-result-item"
            style={{ display: 'block', textDecoration: 'none', color: 'inherit' }}
          >
            <div className="flex items-center gap-2">
              <span className={`badge badge-${result.type}`}>{result.type}</span>
              <span style={{ fontWeight: 600 }}>{result.title}</span>
              <span className="text-muted text-xs">
                {result.project}
              </span>
              <span className="search-score text-xs" style={{ marginLeft: 'auto' }}>
                score: {(typeof result.score === 'number' && !isNaN(result.score) ? result.score.toFixed(4) : 'N/A')}
              </span>
            </div>
            {result.snippet && (
              <div className="search-snippet">"{result.snippet}"</div>
            )}
            <div className="text-xs text-muted" style={{ marginTop: 4 }}>
              {new Date(result.created).toLocaleDateString()}{' '}
              {new Date(result.created).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}
