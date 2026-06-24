import React, { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { apiClient, ApiError, type DocListItem, type PaginatedResponse } from '../api/client';

const DOC_TYPES = ['prd', 'research', 'design', 'architecture', 'notes'] as const;
const STATUS_ORDER = ['final', 'in_review', 'synthesizing', 'draft'] as const;

// Curated "known" projects shown first in the picker. Everything else falls into
// the "Other" optgroup. Date-slug projects (e.g. per-run "2026-06-14-…") are
// forced into Other regardless, so one-off pipeline slugs never crowd the top.
//
// Set VITE_DOCVAULT_PINNED_PROJECTS to a comma-separated list to pin your own
// projects, e.g. VITE_DOCVAULT_PINNED_PROJECTS="docs,research,infra".
// Defaults to empty: every project sorts into "Other" by document count.
const PINNED_PROJECTS = (import.meta.env.VITE_DOCVAULT_PINNED_PROJECTS ?? '')
  .split(',')
  .map((s: string) => s.trim())
  .filter(Boolean);

const DATE_SLUG = /^\d{4}-\d{2}-\d{2}-/;
const MAX_PAGES = 30; // safety cap: 30 × 100 = 3000 docs before we stop & warn

type SortKey = 'created' | 'updated' | 'commented';
type SortOrder = 'asc' | 'desc';
type GroupKey = 'project' | 'type' | 'bot' | 'status';

const SORT_LABELS: Record<SortKey, string> = {
  created: 'Created',
  updated: 'Updated',
  commented: 'Commented',
};

const GROUP_LABELS: Record<GroupKey, string> = {
  project: 'Project',
  type: 'Type',
  bot: 'Bot',
  status: 'Status',
};

// ── Bot colour badges ────────────────────────────────────────────────────────
// Colours are derived deterministically from the agent id (see hashColor), so
// every bot gets a stable badge with no hardcoded names. To override a specific
// bot's colours, add an entry here keyed by agent id.
const BOT_COLORS: Record<string, { bg: string; fg: string }> = {};

function hashColor(s: string): { bg: string; fg: string } {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  const hue = h % 360;
  return { bg: `hsl(${hue} 70% 90%)`, fg: `hsl(${hue} 65% 32%)` };
}

function botStyle(id?: string): React.CSSProperties | undefined {
  if (!id) return undefined;
  const c = BOT_COLORS[id] ?? hashColor(id);
  return { background: c.bg, color: c.fg };
}

// ── Version collapse ─────────────────────────────────────────────────────────
// Strip a trailing version token so "Pitch Deck v1.1" and "Pitch Deck v1.0"
// fold together. Conservative: only docs sharing (project, type, base-title)
// collapse, so unrelated docs are never merged.
function baseTitle(t: string): string {
  return t
    .replace(/\s*\(v\d+(\.\d+)*\)\s*$/i, '')
    .replace(/\s*[-—–]?\s*v\d+(\.\d+)*\s*$/i, '')
    .trim()
    .toLowerCase();
}

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  return `${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
}

function tsOf(d: DocListItem, key: SortKey): number {
  const v = key === 'created' ? d.created : key === 'updated' ? d.updated : d.commented;
  const t = v ? new Date(v).getTime() : 0;
  return isNaN(t) ? 0 : t;
}

function groupValue(d: DocListItem, key: GroupKey): string {
  switch (key) {
    case 'project':
      return d.project || '—';
    case 'type':
      return d.type || '—';
    case 'bot':
      return d.agent_id || 'unknown';
    case 'status':
      return d.status || '—';
  }
}

interface VersionGroup {
  key: string;
  head: DocListItem;
  rest: DocListItem[]; // older versions, newest-first
}

interface Section {
  label: string;
  docCount: number;
  items: VersionGroup[];
}

// ── Row ──────────────────────────────────────────────────────────────────────
function DocRow({
  doc,
  indent = false,
  extraMeta,
}: {
  doc: DocListItem;
  indent?: boolean;
  extraMeta?: React.ReactNode;
}) {
  return (
    <Link
      to={`/docs/${doc.id}`}
      className="doc-list-item"
      style={indent ? { paddingLeft: 44 } : undefined}
    >
      <div
        className={`doc-embed-indicator ${doc.indexed ? 'doc-embed-ready' : 'doc-embed-pending'}`}
        title={doc.indexed ? 'Indexed' : 'Pending embedding'}
      />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="doc-list-title">
          {doc.title}
          {doc.version > 1 && (
            <span className="badge badge-version" title={`Version ${doc.version}`}>
              v{doc.version}
            </span>
          )}
        </div>
        <div className="doc-list-meta">
          <span className={`badge badge-${doc.type}`}>{doc.type}</span>
          <span>{doc.project}</span>
          {doc.agent_id && (
            <span className="badge" style={botStyle(doc.agent_id)} title="Created by">
              {doc.agent_id}
            </span>
          )}
          {typeof doc.words === 'number' && <span>{doc.words.toLocaleString()} words</span>}
          {(doc as { comments?: number }).comments !== undefined && (
            <span>💬 {(doc as { comments?: number }).comments}</span>
          )}
          {doc.status && <span className={`badge badge-${doc.status}`}>{doc.status}</span>}
          {extraMeta}
        </div>
        <div className="doc-list-meta text-xs text-muted" style={{ marginTop: 2 }}>
          <span title={doc.created}>📄 created {fmtDate(doc.created)}</span>
          <span title={doc.updated}>✏️ updated {fmtDate(doc.updated)}</span>
          <span title={doc.commented ?? undefined}>💬 commented {fmtDate(doc.commented)}</span>
        </div>
        {doc.tags && doc.tags.length > 0 && (
          <div className="flex gap-2 mt-2">
            {doc.tags.map((tag) => (
              <span
                key={tag}
                className="badge"
                style={{ background: 'var(--color-bg-tertiary)', color: 'var(--color-text-secondary)' }}
              >
                #{tag}
              </span>
            ))}
          </div>
        )}
      </div>
    </Link>
  );
}

export function DocList() {
  // Browse-mode data: load the full corpus once, then group/filter in-browser.
  const [allDocs, setAllDocs] = useState<DocListItem[]>([]);
  const [loadingAll, setLoadingAll] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);

  // Search overlays the browse view.
  const [search, setSearch] = useState('');
  const [searchResults, setSearchResults] = useState<DocListItem[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Controls
  const [groupBy, setGroupBy] = useState<GroupKey>('project');
  const [typeFilter, setTypeFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [botFilter, setBotFilter] = useState('');
  const [projectFilter, setProjectFilter] = useState('');
  const [sort, setSort] = useState<SortKey>('created');
  const [order, setOrder] = useState<SortOrder>('desc');

  // Search-result sort (client-side; full set already in browser)
  const [searchSort, setSearchSort] = useState<SortKey | 'relevance'>('relevance');
  const [searchOrder, setSearchOrder] = useState<SortOrder>('desc');

  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(new Set());

  // ── Load all documents (cursor-paged) ──────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoadingAll(true);
      setLoadError(null);
      const acc: DocListItem[] = [];
      let cursor: string | undefined;
      let pages = 0;
      try {
        do {
          const params = new URLSearchParams();
          params.set('sort', 'created');
          params.set('order', 'desc');
          params.set('limit', '100');
          if (cursor) params.set('cursor', cursor);
          const page = await apiClient.get<PaginatedResponse<DocListItem>>(
            `/documents?${params.toString()}`
          );
          acc.push(...page.data);
          cursor = page.next ?? undefined;
          pages++;
        } while (cursor && pages < MAX_PAGES);
        if (!cancelled) {
          setAllDocs(acc);
          setTruncated(Boolean(cursor)); // stopped at the cap with more remaining
        }
      } catch (err) {
        if (!cancelled) {
          if (err instanceof ApiError && err.status === 401) {
            setLoadError('Your session has expired — please log in again.');
          } else if (err instanceof ApiError) {
            setLoadError(`Could not load documents: ${err.detail}`);
          } else {
            setLoadError('Could not load documents: could not reach the server.');
          }
        }
      } finally {
        if (!cancelled) setLoadingAll(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // ── Search ──────────────────────────────────────────────────────────────────
  const handleSearch = useCallback(
    (q: string) => {
      setSearch(q);
      if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
      if (!q.trim()) {
        setSearchResults(null);
        setSearchError(null);
        return;
      }
      searchTimerRef.current = setTimeout(async () => {
        setSearching(true);
        setSearchError(null);
        try {
          const result = await apiClient.post<{ data: DocListItem[] }>('/search', {
            q,
            mode: 'hybrid',
            limit: 20,
            ...(typeFilter ? { type: typeFilter } : {}),
            ...(projectFilter ? { project: projectFilter } : {}),
          });
          setSearchResults(result.data);
        } catch (err) {
          setSearchResults([]);
          if (err instanceof ApiError && err.status === 401) {
            setSearchError('Your session has expired — please log in again to search.');
          } else if (err instanceof ApiError) {
            setSearchError(`Search failed: ${err.detail}`);
          } else {
            setSearchError('Search failed: could not reach the server.');
          }
        } finally {
          setSearching(false);
        }
      }, 300);
    },
    [typeFilter, projectFilter]
  );

  const handleSort = (key: SortKey) => {
    if (sort === key) setOrder(order === 'desc' ? 'asc' : 'desc');
    else {
      setSort(key);
      setOrder('desc');
    }
  };
  const handleSearchSort = (key: SortKey | 'relevance') => {
    if (searchSort === key) setSearchOrder(searchOrder === 'desc' ? 'asc' : 'desc');
    else {
      setSearchSort(key);
      setSearchOrder('desc');
    }
  };

  // ── Derived: distinct projects (with counts) & bots ─────────────────────────
  const projectCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const d of allDocs) m.set(d.project, (m.get(d.project) ?? 0) + 1);
    return m;
  }, [allDocs]);

  const { pinnedProjects, otherProjects } = useMemo(() => {
    const all = [...projectCounts.keys()];
    const pinned = PINNED_PROJECTS.filter((p) => projectCounts.has(p) && !DATE_SLUG.test(p));
    const pinnedSet = new Set(pinned);
    const other = all
      .filter((p) => !pinnedSet.has(p))
      .sort((a, b) => (projectCounts.get(b)! - projectCounts.get(a)!) || a.localeCompare(b));
    return { pinnedProjects: pinned, otherProjects: other };
  }, [projectCounts]);

  const bots = useMemo(() => {
    const s = new Set<string>();
    for (const d of allDocs) if (d.agent_id) s.add(d.agent_id);
    return [...s].sort();
  }, [allDocs]);

  // ── Filters ─────────────────────────────────────────────────────────────────
  const matchesFilters = useCallback(
    (d: DocListItem) =>
      (!typeFilter || d.type === typeFilter) &&
      (!statusFilter || d.status === statusFilter) &&
      (!botFilter || (d.agent_id ?? '') === botFilter) &&
      (!projectFilter || d.project === projectFilter),
    [typeFilter, statusFilter, botFilter, projectFilter]
  );

  // ── Sections (browse mode) ───────────────────────────────────────────────────
  const sections = useMemo<Section[]>(() => {
    const filtered = allDocs.filter(matchesFilters);

    // 1. bucket by group key
    const buckets = new Map<string, DocListItem[]>();
    for (const d of filtered) {
      const k = groupValue(d, groupBy);
      const arr = buckets.get(k);
      if (arr) arr.push(d);
      else buckets.set(k, [d]);
    }

    // 2. within each bucket, collapse versions
    const result: Section[] = [];
    for (const [label, docs] of buckets) {
      const vmap = new Map<string, DocListItem[]>();
      for (const d of docs) {
        const k = `${d.project} ${d.type} ${baseTitle(d.title)}`;
        const arr = vmap.get(k);
        if (arr) arr.push(d);
        else vmap.set(k, [d]);
      }
      const items: VersionGroup[] = [];
      for (const [k, group] of vmap) {
        const ordered = [...group].sort(
          (a, b) => b.version - a.version || tsOf(b, 'created') - tsOf(a, 'created')
        );
        items.push({ key: k, head: ordered[0], rest: ordered.slice(1) });
      }
      // 3. sort items within section by chosen sort key (on head)
      items.sort((a, b) => {
        const d = tsOf(a.head, sort) - tsOf(b.head, sort);
        return order === 'desc' ? -d : d;
      });
      result.push({ label, docCount: docs.length, items });
    }

    // 4. order the sections
    const rank = (label: string): number => {
      if (groupBy === 'project') {
        const i = pinnedProjects.indexOf(label);
        return i === -1 ? 1000 : i;
      }
      if (groupBy === 'type') {
        const i = (DOC_TYPES as readonly string[]).indexOf(label);
        return i === -1 ? 1000 : i;
      }
      if (groupBy === 'status') {
        const i = (STATUS_ORDER as readonly string[]).indexOf(label);
        return i === -1 ? 1000 : i;
      }
      return 1000;
    };
    result.sort((a, b) => {
      const r = rank(a.label) - rank(b.label);
      if (r !== 0) return r;
      return b.docCount - a.docCount || a.label.localeCompare(b.label);
    });
    return result;
  }, [allDocs, matchesFilters, groupBy, sort, order, pinnedProjects]);

  // ── Search results (flat, client-sorted, client-filtered) ───────────────────
  const searchDocs = useMemo<DocListItem[]>(() => {
    if (searchResults === null) return [];
    const items = searchResults.filter(matchesFilters);
    if (searchSort === 'relevance') return items;
    const key = searchSort;
    return [...items].sort((a, b) =>
      searchOrder === 'desc' ? tsOf(b, key) - tsOf(a, key) : tsOf(a, key) - tsOf(b, key)
    );
  }, [searchResults, searchSort, searchOrder, matchesFilters]);

  const toggleExpand = (k: string) =>
    setExpanded((prev) => {
      const n = new Set(prev);
      n.has(k) ? n.delete(k) : n.add(k);
      return n;
    });
  const toggleSection = (label: string) =>
    setCollapsedSections((prev) => {
      const n = new Set(prev);
      n.has(label) ? n.delete(label) : n.add(label);
      return n;
    });

  // Collapse/expand every section at once. allCollapsed reflects current state so
  // the single button flips its action and label.
  const allCollapsed = sections.length > 0 && sections.every((s) => collapsedSections.has(s.label));
  const collapseAll = () => setCollapsedSections(new Set(sections.map((s) => s.label)));
  const expandAll = () => setCollapsedSections(new Set());

  const selectStyle: React.CSSProperties = { width: 'auto' };

  return (
    <div>
      {/* Toolbar */}
      <div className="page-header">
        <h1 className="page-title">Documents</h1>
        <div className="flex gap-2 items-center" style={{ flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          <label className="text-sm text-muted flex items-center gap-2">
            Group by
            <select
              className="input"
              style={selectStyle}
              value={groupBy}
              onChange={(e) => setGroupBy(e.target.value as GroupKey)}
            >
              {(Object.keys(GROUP_LABELS) as GroupKey[]).map((k) => (
                <option key={k} value={k}>
                  {GROUP_LABELS[k]}
                </option>
              ))}
            </select>
          </label>

          <select className="input" style={selectStyle} value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}>
            <option value="">All types</option>
            {DOC_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>

          <select className="input" style={selectStyle} value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
            <option value="">All statuses</option>
            {STATUS_ORDER.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>

          <select className="input" style={selectStyle} value={botFilter} onChange={(e) => setBotFilter(e.target.value)}>
            <option value="">All bots</option>
            {bots.map((b) => (
              <option key={b} value={b}>
                {b}
              </option>
            ))}
          </select>

          <select className="input" style={selectStyle} value={projectFilter} onChange={(e) => setProjectFilter(e.target.value)}>
            <option value="">All projects</option>
            {pinnedProjects.length > 0 && (
              <optgroup label="Pinned">
                {pinnedProjects.map((p) => (
                  <option key={p} value={p}>
                    {p} ({projectCounts.get(p)})
                  </option>
                ))}
              </optgroup>
            )}
            {otherProjects.length > 0 && (
              <optgroup label="Other">
                {otherProjects.map((p) => (
                  <option key={p} value={p}>
                    {p} ({projectCounts.get(p)})
                  </option>
                ))}
              </optgroup>
            )}
          </select>
        </div>
      </div>

      {/* Search bar */}
      <div className="search-bar">
        <div className="search-input-wrap">
          <input
            className="input"
            placeholder="Search documents (hybrid semantic + keyword)..."
            value={search}
            onChange={(e) => handleSearch(e.target.value)}
            aria-label="Search documents"
          />
        </div>
        {searching && <span className="text-muted text-sm">Searching...</span>}
      </div>

      {(searchError || loadError) && (
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
          ⚠️ {searchError ?? loadError}
        </div>
      )}

      {truncated && !search && (
        <div className="text-xs text-muted" style={{ padding: '6px 20px' }}>
          Showing the first {allDocs.length} documents (cap reached) — narrow with a filter to see the rest.
        </div>
      )}

      {/* Sort controls */}
      <div
        className="flex gap-2 items-center text-sm"
        style={{ padding: '8px 20px', borderBottom: '1px solid var(--color-border)' }}
      >
        <span className="text-muted">Sort by:</span>
        {search ? (
          <>
            <button
              className={`btn btn-sm ${searchSort === 'relevance' ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => handleSearchSort('relevance')}
              title="Best match first (server ranking)"
            >
              Relevance
            </button>
            {(Object.keys(SORT_LABELS) as SortKey[]).map((key) => (
              <button
                key={key}
                className={`btn btn-sm ${searchSort === key ? 'btn-primary' : 'btn-secondary'}`}
                onClick={() => handleSearchSort(key)}
                title={`Sort results by ${SORT_LABELS[key].toLowerCase()} date`}
              >
                {SORT_LABELS[key]}
                {searchSort === key ? (searchOrder === 'desc' ? ' ↓' : ' ↑') : ''}
              </button>
            ))}
          </>
        ) : (
          (Object.keys(SORT_LABELS) as SortKey[]).map((key) => (
            <button
              key={key}
              className={`btn btn-sm ${sort === key ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => handleSort(key)}
              title={`Sort by ${SORT_LABELS[key].toLowerCase()} date`}
            >
              {SORT_LABELS[key]}
              {sort === key ? (order === 'desc' ? ' ↓' : ' ↑') : ''}
            </button>
          ))
        )}
        {!search && sections.length > 0 && (
          <button
            className="btn btn-sm btn-secondary"
            style={{ marginLeft: 'auto' }}
            onClick={allCollapsed ? expandAll : collapseAll}
            title={allCollapsed ? 'Expand every section' : 'Collapse every section'}
          >
            {allCollapsed ? '▸ Expand all' : '▾ Collapse all'}
          </button>
        )}
      </div>

      {/* List */}
      <div className="doc-list">
        {loadingAll && allDocs.length === 0 && (
          <div className="p-4 text-muted">Loading documents...</div>
        )}

        {/* Search mode: flat list */}
        {search ? (
          <>
            {searchDocs.length === 0 && !searching && !searchError && (
              <div className="p-4 text-muted">No search results.</div>
            )}
            {searchDocs.map((doc) => (
              <DocRow key={doc.id} doc={doc} />
            ))}
          </>
        ) : (
          <>
            {!loadingAll && sections.length === 0 && !loadError && (
              <div className="p-4 text-muted">No documents match these filters.</div>
            )}
            {sections.map((section) => {
              const collapsed = collapsedSections.has(section.label);
              return (
                <div key={section.label} className="doc-section">
                  <button
                    className="doc-section-header"
                    onClick={() => toggleSection(section.label)}
                    aria-expanded={!collapsed}
                  >
                    <span className="doc-section-chevron">{collapsed ? '▸' : '▾'}</span>
                    {groupBy === 'bot' ? (
                      <span className="badge" style={botStyle(section.label)}>
                        {section.label}
                      </span>
                    ) : groupBy === 'type' || groupBy === 'status' ? (
                      <span className={`badge badge-${section.label}`}>{section.label}</span>
                    ) : (
                      <span className="doc-section-title">{section.label}</span>
                    )}
                    <span className="text-muted text-sm">
                      {section.items.length} item{section.items.length === 1 ? '' : 's'}
                      {section.docCount !== section.items.length ? ` · ${section.docCount} docs` : ''}
                    </span>
                  </button>

                  {!collapsed &&
                    section.items.map((vg) => {
                      const isOpen = expanded.has(vg.key);
                      return (
                        <div key={vg.key}>
                          <DocRow
                            doc={vg.head}
                            extraMeta={
                              vg.rest.length > 0 ? (
                                <button
                                  className="version-toggle"
                                  onClick={(e) => {
                                    e.preventDefault();
                                    e.stopPropagation();
                                    toggleExpand(vg.key);
                                  }}
                                  title="Show older versions"
                                >
                                  {isOpen ? '▾' : '▸'} {vg.rest.length} older
                                  {vg.rest.length === 1 ? ' version' : ' versions'}
                                </button>
                              ) : undefined
                            }
                          />
                          {isOpen &&
                            vg.rest.map((old) => <DocRow key={old.id} doc={old} indent />)}
                        </div>
                      );
                    })}
                </div>
              );
            })}
          </>
        )}
      </div>
    </div>
  );
}
