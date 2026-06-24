import { useEffect, useRef, useCallback } from 'react';
import type { TextAnnotator, TextAnnotationLike } from '@recogito/text-annotator';
import { useUIStore } from '../store/ui';
import type { Comment, CommentSelector } from '../api/client';

interface UseAnnotationsOptions {
  docId: string;
  containerRef: React.RefObject<HTMLElement | null>;
  onAnnotationCreated?: (selector: CommentSelector) => void;
  comments: Comment[];
}

// ── Selector extraction helpers ──────────────────────────────────────────────
// recogito v4 returns target.selector as a W3C array of typed selectors.
// Earlier code treated it as a plain object — that's why exact was always "".

interface RecogitoSelector {
  type: string;
  exact?: string;
  prefix?: string;
  suffix?: string;
  start?: number;
  end?: number;
}

function extractSelector(annotation: unknown): CommentSelector | null {
  const ann = annotation as {
    target?: { selector?: RecogitoSelector | RecogitoSelector[] };
  };
  const raw = ann.target?.selector;
  if (!raw) return null;

  // Normalise: accept both array (v4 W3C) and plain object (legacy)
  const selectors: RecogitoSelector[] = Array.isArray(raw) ? raw : [raw];

  const quote = selectors.find((s) => s.type === 'TextQuoteSelector');
  const pos   = selectors.find((s) => s.type === 'TextPositionSelector');

  // Always fall back to native Selection API for the exact text so we never
  // show an empty quote even if recogito's extractor misfires.
  const nativeExact = window.getSelection()?.toString().trim() ?? '';

  const exact = quote?.exact?.trim() || nativeExact;
  if (!exact) return null;

  return {
    quote: {
      exact,
      pre:  quote?.prefix ?? '',
      post: quote?.suffix ?? '',
    },
    pos: {
      start: pos?.start ?? 0,
      end:   pos?.end   ?? exact.length,
    },
  };
}

// ── Floating comment bubble ───────────────────────────────────────────────────
// Shows a small pill near the selection instead of auto-opening the panel.
// Clicking the pill locks the selection and opens the composer.

function createBubble(): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.id = 'dv-comment-bubble';
  btn.textContent = '💬 Comment';
  Object.assign(btn.style, {
    position:     'absolute',
    zIndex:       '9999',
    padding:      '4px 10px',
    fontSize:     '12px',
    fontWeight:   '600',
    background:   '#2563eb',
    color:        '#fff',
    border:       'none',
    borderRadius: '99px',
    cursor:       'pointer',
    boxShadow:    '0 2px 8px rgba(0,0,0,0.25)',
    pointerEvents:'auto',
    whiteSpace:   'nowrap',
    userSelect:   'none',
  });
  document.body.appendChild(btn);
  return btn;
}

function positionBubble(btn: HTMLButtonElement, range: Range) {
  const rect = range.getBoundingClientRect();
  const scrollY = window.scrollY;
  const scrollX = window.scrollX;
  btn.style.top  = `${rect.bottom + scrollY + 6}px`;
  btn.style.left = `${rect.left + scrollX + rect.width / 2 - 46}px`;
  btn.style.display = 'block';
}

/**
 * Mounts recogito/text-annotator-js over the rendered markdown container.
 * Shows a floating "💬 Comment" bubble on selection (Option B UX).
 * The bubble click locks the quote and opens the composer.
 * Fixes recogito v4 array-selector bug — exact text is always populated.
 */
export function useAnnotations({
  docId,
  containerRef,
  onAnnotationCreated,
  comments,
}: UseAnnotationsOptions) {
  const annotatorRef  = useRef<unknown | null>(null);
  const bubbleRef     = useRef<HTMLButtonElement | null>(null);
  const pendingSel    = useRef<CommentSelector | null>(null);

  const setPendingSelector    = useUIStore((s) => s.setPendingSelector);
  const setCommentPanelOpen   = useUIStore((s) => s.setCommentPanelOpen);
  const setActiveAnnotationId = useUIStore((s) => s.setActiveAnnotationId);

  // ── Floating bubble logic ─────────────────────────────────────────────────
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const bubble = createBubble();
    bubble.style.display = 'none';
    bubbleRef.current = bubble;

    const hideBubble = () => {
      bubble.style.display = 'none';
      pendingSel.current = null;
    };

    const handleMouseUp = () => {
      // Small delay so the selection is finalised before we read it
      setTimeout(() => {
        const sel = window.getSelection();
        if (!sel || sel.isCollapsed || !sel.toString().trim()) {
          hideBubble();
          return;
        }
        // Only show bubble when selection is inside the doc container
        if (!container.contains(sel.anchorNode)) { hideBubble(); return; }

        const range = sel.getRangeAt(0);
        const exact = sel.toString().trim();
        const nativeSelector: CommentSelector = {
          quote: { exact, pre: '', post: '' },
          pos: { start: 0, end: exact.length },
        };
        pendingSel.current = nativeSelector;
        positionBubble(bubble, range);
      }, 10);
    };

    const handleBubbleClick = (e: MouseEvent) => {
      e.stopPropagation();
      const sel = pendingSel.current;
      hideBubble();
      window.getSelection()?.removeAllRanges();
      if (!sel) return;
      setPendingSelector(sel);
      setCommentPanelOpen(true);
      onAnnotationCreated?.(sel);
    };

    // Hide on any click that isn't the bubble itself
    const handleDocClick = (e: MouseEvent) => {
      if (e.target !== bubble) hideBubble();
    };

    document.addEventListener('mouseup', handleMouseUp);
    document.addEventListener('click', handleDocClick);
    bubble.addEventListener('click', handleBubbleClick);

    return () => {
      document.removeEventListener('mouseup', handleMouseUp);
      document.removeEventListener('click', handleDocClick);
      bubble.removeEventListener('click', handleBubbleClick);
      bubble.remove();
      bubbleRef.current = null;
    };
  }, [containerRef, onAnnotationCreated, setPendingSelector, setCommentPanelOpen]);

  // ── Touch fallback ────────────────────────────────────────────────────────
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let touchMoved = false;
    const onTouchStart = () => { touchMoved = false; };
    const onTouchMove  = () => { touchMoved = true; };

    const onTouchEnd = (e: TouchEvent) => {
      if (touchMoved) return;
      const sel = window.getSelection();
      if (sel && sel.toString().trim().length > 0) return; // recogito handles it

      const block = (e.target as Element).closest(
        'p, h1, h2, h3, h4, h5, h6, li, blockquote, pre'
      ) as HTMLElement | null;
      if (!block) return;

      const exact = block.textContent?.trim() ?? '';
      if (!exact) return;

      const selector: CommentSelector = {
        quote: { exact, pre: '', post: '' },
        pos: { start: 0, end: exact.length },
      };
      setPendingSelector(selector);
      setCommentPanelOpen(true);
      onAnnotationCreated?.(selector);
      e.preventDefault();
    };

    container.addEventListener('touchstart', onTouchStart, { passive: true });
    container.addEventListener('touchmove',  onTouchMove,  { passive: true });
    container.addEventListener('touchend',   onTouchEnd,   { passive: false });

    return () => {
      container.removeEventListener('touchstart', onTouchStart);
      container.removeEventListener('touchmove',  onTouchMove);
      container.removeEventListener('touchend',   onTouchEnd);
    };
  }, [containerRef, onAnnotationCreated, setPendingSelector, setCommentPanelOpen]);

  // ── Recogito annotator (existing-annotation highlights + click) ───────────
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let anno: TextAnnotator<TextAnnotationLike, TextAnnotationLike> | null = null;

    import('@recogito/text-annotator')
      .then(({ createTextAnnotator }) => {
        const annotator = createTextAnnotator(container, {
          style: { fill: '#fef3c7', fillOpacity: 0.6 },
        });

        anno = annotator;
        annotatorRef.current = annotator;

        // Restore saved inline comments as highlights
        const inlineComments = comments.filter(
          (c) => c.type === 'inline' && c.selector && !c.anchor_lost
        );
        const annotations = inlineComments.map((c) => ({
          id: c.id,
          type: 'Annotation',
          body: [{ type: 'TextualBody', value: c.body, purpose: 'commenting' }],
          target: {
            selector: [
              {
                type: 'TextQuoteSelector',
                exact:  c.selector!.quote.exact,
                prefix: c.selector!.quote.pre,
                suffix: c.selector!.quote.post,
              },
              {
                type:  'TextPositionSelector',
                start: c.selector!.pos.start,
                end:   c.selector!.pos.end,
              },
            ],
          },
        }));
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        annotator.setAnnotations(annotations as any);

        // createAnnotation fires when user selects text via recogito.
        // We use extractSelector() to correctly handle the v4 array format.
        // The bubble already captured the native selection; override if
        // recogito gives us richer position data.
        annotator.on('createAnnotation', (annotation: unknown) => {
          const sel = extractSelector(annotation);
          if (!sel?.quote.exact) return;
          // Replace bubble's pending selector with recogito's richer one,
          // but don't open the panel — the bubble click does that.
          pendingSel.current = sel;
        });

        // Click on an existing highlight → scroll panel to that thread
        annotator.on('clickAnnotation', (annotation: unknown) => {
          const ann = annotation as { id?: string };
          if (ann.id) {
            setActiveAnnotationId(ann.id);
            setCommentPanelOpen(true);
          }
        });
      })
      .catch((err) =>
        console.warn('[recogito] not available, using bubble fallback:', err)
      );

    return () => {
      if (anno) anno.destroy();
      annotatorRef.current = null;
    };
  }, [
    docId, containerRef, comments,
    onAnnotationCreated, setPendingSelector,
    setCommentPanelOpen, setActiveAnnotationId,
  ]);

  return annotatorRef;
}
