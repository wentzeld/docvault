import React, { useRef, useState, useCallback, useMemo } from 'react';
import { useParams, Link } from 'react-router-dom';
import useSWR from 'swr';
import { apiClient, type DocDetail as DocDetailType, type Comment, type PaginatedResponse, type VersionSnapshot, type VersionDetail, type VersionListResponse } from '../api/client';
import { CommentPanel } from './CommentPanel';
import { ReviewHistory } from './ReviewHistory';
import { useAnnotations } from '../hooks/useAnnotations';
import { useUIStore } from '../store/ui';

function fetcher<T>(url: string) {
  return apiClient.get<T>(url);
}

type Verdict = 'approved' | 'changes_requested';
type SubmitState = 'idle' | 'submitting' | 'error';
type ResendState = 'idle' | 'sending' | 'sent' | 'working';
type SaveState = 'idle' | 'saving' | 'saved' | 'error';

export function DocDetail() {
  const { id } = useParams<{ id: string }>();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [showRaw, setShowRaw] = useState(false);
  const [showHistory, setShowHistory] = useState(false);

  // Review state
  const [pendingVerdict, setPendingVerdict] = useState<Verdict | null>(null);
  const [reviewComment, setReviewComment] = useState('');
  const [submitState, setSubmitState] = useState<SubmitState>('idle');
  const [doneVerdict, setDoneVerdict] = useState<Verdict | null>(null);
  const [docStatus, setDocStatus] = useState<string | null>(null);

  // Resend state
  const [resendState, setResendState] = useState<ResendState>('idle');

  // Version selector state
  const [selectedVersion, setSelectedVersion] = useState<number | null>(null);
  const [versionDropdownOpen, setVersionDropdownOpen] = useState(false);

  // Edit mode state
  const [editMode, setEditMode] = useState(false);
  const [editContent, setEditContent] = useState('');
  const [saveState, setSaveState] = useState<SaveState>('idle');

  const setCommentPanelOpen = useUIStore((s) => s.setCommentPanelOpen);

  // ── Review callbacks (no doc dep) ──────────────────────────────────────────

  const openReview = useCallback((verdict: Verdict) => {
    setPendingVerdict(verdict);
    setReviewComment('');
    setSubmitState('idle');
  }, []);

  const cancelReview = useCallback(() => {
    setPendingVerdict(null);
    setReviewComment('');
    setSubmitState('idle');
  }, []);

  const handleResend = useCallback(async () => {
    if (!id) return;
    setResendState('sending');
    try {
      await apiClient.post(`/documents/${id}/resend-notification`, {});
      setResendState('sent');
      setTimeout(() => setResendState('idle'), 4000);
    } catch (err: unknown) {
      if (err && typeof err === 'object' && 'status' in err && (err as { status: number }).status === 409) {
        setResendState('working');
        setTimeout(() => setResendState('idle'), 4000);
      } else {
        setResendState('idle');
      }
    }
  }, [id]);

  // ── SWR data ───────────────────────────────────────────────────────────────

  const {
    data: doc,
    isLoading: docLoading,
    error: docError,
    mutate: mutateDoc,
  } = useSWR<DocDetailType>(id ? `/documents/${id}` : null, fetcher);

  const {
    data: commentsData,
    mutate: mutateComments,
  } = useSWR<PaginatedResponse<Comment>>(
    id ? `/documents/${id}/comments?limit=200` : null,
    fetcher,
    { revalidateOnFocus: false }
  );

  const comments = commentsData?.data ?? [];

  const { data: versionsData } = useSWR<VersionListResponse>(
    doc && doc.version > 1 ? `/documents/${id}/versions` : null,
    fetcher,
    { revalidateOnFocus: false }
  );

  const { data: pastVersion, isLoading: pastVersionLoading } = useSWR<VersionDetail>(
    selectedVersion !== null && id ? `/documents/${id}/versions/${selectedVersion}` : null,
    fetcher,
    { revalidateOnFocus: false }
  );

  // ── Derived state ──────────────────────────────────────────────────────────

  const isDirty = editMode && editContent !== (doc?.content ?? '');

  const resendVisible = useMemo(() => {
    const reviewEvents = comments.filter(c => {
      const body = c.body ?? '';
      return body.startsWith('**[review:') || body.startsWith('[status:');
    }).sort((a, b) => new Date(a.created).getTime() - new Date(b.created).getTime());

    if (reviewEvents.length === 0) return false;

    const lastChangesReq = [...reviewEvents].reverse().find(c =>
      (c.body ?? '').startsWith('**[review:changes_requested]**')
    );
    if (!lastChangesReq) return false;

    const processingAfter = reviewEvents.filter(c =>
      (c.body ?? '').startsWith('[status:processing]') &&
      new Date(c.created).getTime() > new Date(lastChangesReq.created).getTime()
    );

    if (processingAfter.length === 0) return true;

    const latestProcessing = processingAfter[processingAfter.length - 1];
    const ageMs = Date.now() - new Date(latestProcessing.created).getTime();
    return ageMs > 3 * 60 * 1000;
  }, [comments]);

  // ── Callbacks that need doc ────────────────────────────────────────────────

  const submitReview = useCallback(async () => {
    if (!id || !pendingVerdict) return;
    setSubmitState('submitting');
    try {
      // Auto-save dirty edits before submitting the review verdict
      if (isDirty && doc) {
        const updated = await apiClient.put<DocDetailType>(`/documents/${id}`, {
          content: editContent,
          version: doc.version,
        });
        await mutateDoc(updated, false);
        setEditMode(false);
        setEditContent('');
      }
      const result = await apiClient.post<{ id: string; verdict: string; status: string }>(
        `/documents/${id}/approve`,
        { verdict: pendingVerdict, comment: reviewComment.trim() || undefined }
      );
      setDocStatus(result.status);
      setDoneVerdict(pendingVerdict);
      setPendingVerdict(null);
      setReviewComment('');
    } catch {
      setSubmitState('error');
      setTimeout(() => setSubmitState('idle'), 3000);
    }
  }, [id, pendingVerdict, reviewComment, isDirty, editContent, doc, mutateDoc]);

  const enterEditMode = useCallback(() => {
    if (!doc) return;
    setEditContent(doc.content);
    setEditMode(true);
    setSelectedVersion(null); // exit past-version view
  }, [doc]);

  const cancelEdit = useCallback(() => {
    setEditMode(false);
    setEditContent('');
    setSaveState('idle');
  }, []);

  const saveEdit = useCallback(async () => {
    if (!id || !doc) return;
    setSaveState('saving');
    try {
      const updated = await apiClient.put<DocDetailType>(`/documents/${id}`, {
        content: editContent,
        version: doc.version,
      });
      await mutateDoc(updated, false);
      setEditMode(false);
      setEditContent('');
      setSaveState('saved');
      setTimeout(() => setSaveState('idle'), 3000);
    } catch {
      setSaveState('error');
      setTimeout(() => setSaveState('idle'), 4000);
    }
  }, [id, doc, editContent, mutateDoc]);

  useAnnotations({
    docId: id ?? '',
    containerRef,
    comments,
    onAnnotationCreated: () => {
      setCommentPanelOpen(true);
    },
  });

  if (docLoading) {
    return <div className="p-4 text-muted">Loading document...</div>;
  }

  if (docError || !doc) {
    return (
      <div className="p-4">
        <div style={{ color: 'var(--color-error)', marginBottom: 12 }}>
          Document not found or failed to load.
        </div>
        <Link to="/" className="btn btn-secondary btn-sm">
          ← Back to list
        </Link>
      </div>
    );
  }

  const effectiveStatus = docStatus ?? doc.status;
  const hasComplete = comments.some(c => (c.body ?? '').startsWith('[status:complete]'));
  const showRevisedBadge = doc.version > 1 && hasComplete;

  return (
    <div style={{ display: 'flex', minHeight: '100vh', flexDirection: 'column' }}>

      {/* ── Header ──────────────────────────────────────────────────────── */}
      <div className="page-header">
        <div className="flex items-center gap-3">
          <Link to="/" className="btn btn-ghost btn-sm">←</Link>
          <div>
            <h1 style={{ fontSize: 18, fontWeight: 700 }}>
              {doc.title}
              {isDirty && (
                <span title="Unsaved edits" style={{ color: 'var(--color-warning)', marginLeft: 6, fontSize: 12 }}>
                  ●
                </span>
              )}
              {saveState === 'saved' && (
                <span style={{ color: 'var(--color-success)', marginLeft: 8, fontSize: 12, fontWeight: 400 }}>
                  ✓ Saved
                </span>
              )}
              {saveState === 'error' && (
                <span style={{ color: 'var(--color-error)', marginLeft: 8, fontSize: 12, fontWeight: 400 }}>
                  Save failed — reload and try again
                </span>
              )}
            </h1>
            <div className="flex gap-2 items-center text-sm text-muted">
              <span className={`badge badge-${doc.type}`}>{doc.type}</span>
              <span>{doc.project}</span>

              {/* Version badge / selector */}
              {doc.version > 1 && versionsData ? (
                <div style={{ position: 'relative', display: 'inline-block' }}>
                  <button
                    className="btn btn-ghost btn-sm"
                    style={{
                      color: selectedVersion !== null ? '#7c3aed' : (showRevisedBadge ? '#d97706' : 'inherit'),
                      fontWeight: 600,
                      padding: '0 6px',
                    }}
                    onClick={() => setVersionDropdownOpen((o) => !o)}
                    title="Version history"
                  >
                    v{selectedVersion ?? doc.version}
                    {selectedVersion === null && showRevisedBadge ? ' · revised' : ''}
                    {' ▾'}
                  </button>
                  {versionDropdownOpen && (
                    <>
                      <div style={{ position: 'fixed', inset: 0, zIndex: 49 }} onClick={() => setVersionDropdownOpen(false)} />
                      <div style={{
                        position: 'absolute', top: '100%', left: 0, zIndex: 50,
                        background: 'var(--color-bg)', border: '1px solid var(--color-border)',
                        borderRadius: 'var(--radius)', boxShadow: '0 4px 12px rgba(0,0,0,0.12)',
                        minWidth: 220, padding: '4px 0',
                      }}>
                        {versionsData.data.map((snap) => (
                          <button
                            key={snap.version}
                            style={{
                              display: 'block', width: '100%', textAlign: 'left',
                              padding: '6px 14px', border: 'none', cursor: 'pointer', fontSize: 13,
                              background: (selectedVersion === snap.version) || (snap.current && selectedVersion === null)
                                ? 'var(--color-bg-secondary)' : 'transparent',
                            }}
                            onClick={() => { setSelectedVersion(snap.current ? null : snap.version); setVersionDropdownOpen(false); }}
                          >
                            <span style={{ fontWeight: 600 }}>v{snap.version}</span>
                            {snap.current && <span style={{ color: 'var(--color-text-secondary)', marginLeft: 6 }}>(current)</span>}
                            <span style={{ color: 'var(--color-text-secondary)', marginLeft: 6 }}>
                              · {new Date(snap.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                            </span>
                            {snap.current && showRevisedBadge && <span style={{ color: '#d97706', marginLeft: 6 }}>· revised</span>}
                          </button>
                        ))}
                      </div>
                    </>
                  )}
                </div>
              ) : showRevisedBadge ? (
                <span style={{ color: '#d97706', fontWeight: 600 }}>v{doc.version} · revised</span>
              ) : (
                <span>v{doc.version}</span>
              )}

              <span>{doc.words.toLocaleString()} words</span>
              <span className={`badge badge-${effectiveStatus}`}>{effectiveStatus}</span>
            </div>
          </div>
        </div>

        {/* Right-side action buttons */}
        <div className="flex gap-2 items-center">
          {/* Post-submission badge */}
          {doneVerdict === 'approved' && (
            <span style={{ color: 'var(--color-success)', fontSize: 13, fontWeight: 600 }}>✅ Approved</span>
          )}
          {doneVerdict === 'changes_requested' && (
            <span style={{ color: 'var(--color-warning)', fontSize: 13, fontWeight: 600 }}>🔄 Changes requested</span>
          )}

          {/* Review buttons — always available unless verdict is done */}
          {!doneVerdict && (
            <>
              <button
                className="btn btn-sm"
                style={{
                  background: pendingVerdict === 'approved' ? 'var(--color-success)' : 'var(--color-success-light)',
                  color: pendingVerdict === 'approved' ? 'white' : 'var(--color-success)',
                  border: '1px solid var(--color-success)',
                }}
                onClick={() => openReview('approved')}
                title="Approve this document"
              >
                ✅ Approve
              </button>
              <button
                className="btn btn-sm"
                style={{
                  background: pendingVerdict === 'changes_requested' ? 'var(--color-warning)' : 'var(--color-warning-light)',
                  color: pendingVerdict === 'changes_requested' ? 'white' : 'var(--color-warning)',
                  border: '1px solid var(--color-warning)',
                }}
                onClick={() => openReview('changes_requested')}
                title="Request changes"
              >
                🔄 Changes
              </button>
            </>
          )}

          {/* Resend */}
          {resendVisible && !editMode && (
            <button
              className="btn btn-sm btn-secondary"
              onClick={handleResend}
              disabled={resendState === 'sending'}
              title="Resend changes_requested notification to the bot"
            >
              {resendState === 'sending' && '⏳ Sending…'}
              {resendState === 'sent' && '✔ Sent'}
              {resendState === 'working' && '⏳ Bot is working…'}
              {resendState === 'idle' && '🔔 Resend'}
            </button>
          )}

          {/* Toolbar — swaps based on edit mode */}
          {editMode ? (
            <>
              <button
                className="btn btn-sm"
                style={{
                  background: isDirty ? 'var(--color-primary)' : 'var(--color-bg-tertiary)',
                  color: isDirty ? 'white' : 'var(--color-text-muted)',
                  border: isDirty ? 'none' : '1px solid var(--color-border)',
                  minWidth: 80,
                }}
                onClick={saveEdit}
                disabled={saveState === 'saving' || !isDirty}
                title={isDirty ? 'Save changes (creates a new version)' : 'No unsaved changes'}
              >
                {saveState === 'saving' ? '⏳ Saving…' : '💾 Save'}
              </button>
              <button className="btn btn-ghost btn-sm" onClick={cancelEdit} title="Discard edits and return to view">
                ✕ Cancel
              </button>
            </>
          ) : (
            <>
              <button
                className="btn btn-ghost btn-sm"
                onClick={() => setShowHistory(!showHistory)}
                title="Toggle review history"
              >
                🕐 History
              </button>
              <button
                className="btn btn-ghost btn-sm"
                onClick={() => setShowRaw(!showRaw)}
                title={showRaw ? 'Show rendered' : 'Show raw markdown'}
              >
                {showRaw ? '👁 Rendered' : '</> Raw'}
              </button>
              <button
                className="btn btn-ghost btn-sm"
                onClick={() => window.print()}
                title="Print / save as PDF"
              >
                🖨 Print
              </button>
              {/* Edit — only for current version */}
              {selectedVersion === null && (
                <button
                  className="btn btn-ghost btn-sm"
                  onClick={enterEditMode}
                  title="Edit markdown directly"
                >
                  ✏️ Edit
                </button>
              )}
            </>
          )}

          <button
            className="btn btn-secondary btn-sm"
            onClick={() => setCommentPanelOpen(true)}
          >
            💬 Comments ({comments.length})
          </button>
        </div>
      </div>

      {/* ── Review History panel ─────────────────────────────────────────── */}
      {showHistory && !editMode && (
        <div style={{ borderBottom: '1px solid var(--color-border)', background: 'var(--color-bg-secondary)' }}>
          <div style={{ maxWidth: 960, margin: '0 auto' }}>
            <ReviewHistory comments={comments} />
          </div>
        </div>
      )}

      {/* ── Past-version banner ──────────────────────────────────────────── */}
      {selectedVersion !== null && (
        <div style={{
          borderBottom: '1px solid var(--color-border)',
          background: '#f5f0ff',
          padding: '10px 20px',
          display: 'flex', alignItems: 'center', gap: 16,
        }}>
          <span style={{ fontSize: 13, color: '#7c3aed', fontWeight: 600 }}>
            Viewing v{selectedVersion} — this is a past version
          </span>
          <button
            className="btn btn-sm"
            style={{ background: '#7c3aed', color: 'white', border: 'none' }}
            onClick={() => setSelectedVersion(null)}
          >
            Back to current
          </button>
        </div>
      )}

      {/* ── Review panel ────────────────────────────────────────────────── */}
      {pendingVerdict && (
        <div style={{
          borderBottom: '1px solid var(--color-border)',
          background: pendingVerdict === 'approved' ? 'var(--color-success-light)' : 'var(--color-warning-light)',
        }}>
          <div style={{ padding: '16px 20px', maxWidth: 960, margin: '0 auto' }}>
            {/* Unsaved edits notice */}
            {isDirty && (
              <div style={{
                fontSize: 12, color: 'var(--color-text-secondary)',
                background: 'rgba(0,0,0,0.05)', borderRadius: 4,
                padding: '5px 10px', marginBottom: 10, display: 'inline-block',
              }}>
                ● Unsaved edits will be saved automatically when you submit
              </div>
            )}

            {/* Verdict toggle row */}
            <div className="flex gap-2 items-center" style={{ marginBottom: 12 }}>
              <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--color-text-secondary)' }}>
                Review type:
              </span>
              <button
                className="btn btn-sm"
                style={{
                  background: pendingVerdict === 'approved' ? 'var(--color-success)' : 'transparent',
                  color: pendingVerdict === 'approved' ? 'white' : 'var(--color-text-secondary)',
                  border: '1px solid var(--color-success)',
                }}
                onClick={() => setPendingVerdict('approved')}
              >
                ✅ Approve
              </button>
              <button
                className="btn btn-sm"
                style={{
                  background: pendingVerdict === 'changes_requested' ? 'var(--color-warning)' : 'transparent',
                  color: pendingVerdict === 'changes_requested' ? 'white' : 'var(--color-text-secondary)',
                  border: '1px solid var(--color-warning)',
                }}
                onClick={() => setPendingVerdict('changes_requested')}
              >
                🔄 Request changes
              </button>
            </div>

            {/* Comment textarea */}
            <textarea
              className="input"
              placeholder={
                pendingVerdict === 'approved'
                  ? 'Leave instructions for the bot before it continues (optional)…'
                  : 'Describe what needs to change. The bot will read this before revising…'
              }
              value={reviewComment}
              onChange={(e) => setReviewComment(e.target.value)}
              style={{ width: '100%', minHeight: 80, resize: 'vertical', marginBottom: 10 }}
              autoFocus={!editMode}
            />

            {/* Actions */}
            <div className="flex gap-2 items-center">
              <button
                className="btn btn-sm"
                style={{
                  background: pendingVerdict === 'approved' ? 'var(--color-success)' : 'var(--color-warning)',
                  color: 'white',
                  minWidth: 160,
                }}
                onClick={submitReview}
                disabled={submitState === 'submitting'}
              >
                {submitState === 'submitting'
                  ? (isDirty ? 'Saving & submitting…' : 'Submitting…')
                  : pendingVerdict === 'approved'
                    ? 'Submit approval ✅'
                    : 'Request changes 🔄'}
              </button>
              <button className="btn btn-ghost btn-sm" onClick={cancelReview}>Cancel</button>
              {submitState === 'error' && (
                <span style={{ color: 'var(--color-error)', fontSize: 13 }}>Failed — try again</span>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ── Content area ────────────────────────────────────────────────── */}
      <div style={{
        display: 'flex',
        flex: 1,
        padding: '24px 32px',
        gap: 24,
        maxWidth: editMode ? 'none' : 960,
        margin: '0 auto',
        width: '100%',
        boxSizing: 'border-box',
      }}>
        {editMode ? (
          /* Edit mode: full-width monospace textarea */
          <textarea
            value={editContent}
            onChange={(e) => setEditContent(e.target.value)}
            spellCheck={false}
            style={{
              flex: 1,
              width: '100%',
              minHeight: 'calc(100vh - 220px)',
              fontFamily: 'var(--font-mono)',
              fontSize: 13,
              lineHeight: 1.7,
              resize: 'none',
              padding: '20px 24px',
              border: '1px solid var(--color-border-strong)',
              borderRadius: 'var(--radius)',
              background: 'var(--color-bg-secondary)',
              color: 'var(--color-text)',
              outline: 'none',
              transition: 'border-color var(--transition)',
            }}
            onFocus={(e) => (e.target.style.borderColor = 'var(--color-primary)')}
            onBlur={(e) => (e.target.style.borderColor = 'var(--color-border-strong)')}
          />
        ) : pastVersionLoading && selectedVersion !== null ? (
          <div className="text-muted" style={{ padding: 20 }}>Loading v{selectedVersion}…</div>
        ) : selectedVersion !== null && pastVersion ? (
          showRaw ? (
            <pre style={{ fontFamily: 'var(--font-mono)', fontSize: 13, background: 'var(--color-bg-secondary)', padding: 20, borderRadius: 'var(--radius)', overflow: 'auto', width: '100%', whiteSpace: 'pre-wrap', wordBreak: 'break-word', border: '1px solid var(--color-border)' }}>
              {pastVersion.content}
            </pre>
          ) : (
            <div
              className="markdown-body"
              dangerouslySetInnerHTML={{ __html: pastVersion.html }}
              style={{ flex: 1, minWidth: 0, opacity: 0.85 }}
            />
          )
        ) : (
          showRaw ? (
            <pre style={{ fontFamily: 'var(--font-mono)', fontSize: 13, background: 'var(--color-bg-secondary)', padding: 20, borderRadius: 'var(--radius)', overflow: 'auto', width: '100%', whiteSpace: 'pre-wrap', wordBreak: 'break-word', border: '1px solid var(--color-border)' }}>
              {doc.content}
            </pre>
          ) : (
            <div
              ref={containerRef}
              className="markdown-body"
              dangerouslySetInnerHTML={{ __html: doc.html }}
              style={{ flex: 1, minWidth: 0 }}
            />
          )
        )}
      </div>

      {/* ── Comment panel ───────────────────────────────────────────────── */}
      {id && (
        <CommentPanel
          docId={id}
          comments={comments}
          onCommentAdded={() => void mutateComments()}
          onCommentResolved={() => void mutateComments()}
        />
      )}
    </div>
  );
}
