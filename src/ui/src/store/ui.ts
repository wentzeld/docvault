import { create } from 'zustand';
import type { CommentSelector } from '../api/client';

interface UIState {
  darkMode: boolean;
  toggleDarkMode: () => void;
  commentPanelOpen: boolean;
  setCommentPanelOpen: (open: boolean) => void;
  activeAnnotationId: string | null;
  setActiveAnnotationId: (id: string | null) => void;
  pendingSelector: CommentSelector | null;
  setPendingSelector: (s: CommentSelector | null) => void;
}

const THEME_KEY = 'docvault-theme';

function getInitialDarkMode(): boolean {
  if (typeof window === 'undefined') return false;
  const stored = localStorage.getItem(THEME_KEY);
  if (stored) return stored === 'dark';
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

export const useUIStore = create<UIState>((set) => ({
  darkMode: getInitialDarkMode(),
  toggleDarkMode: () =>
    set((state) => {
      const next = !state.darkMode;
      localStorage.setItem(THEME_KEY, next ? 'dark' : 'light');
      document.documentElement.setAttribute(
        'data-theme',
        next ? 'dark' : 'light'
      );
      return { darkMode: next };
    }),
  commentPanelOpen: false,
  setCommentPanelOpen: (open) => set({ commentPanelOpen: open }),
  activeAnnotationId: null,
  setActiveAnnotationId: (id) => set({ activeAnnotationId: id }),
  pendingSelector: null,
  setPendingSelector: (s) => set({ pendingSelector: s }),
}));

// Apply initial theme
if (typeof document !== 'undefined') {
  const isDark = getInitialDarkMode();
  document.documentElement.setAttribute('data-theme', isDark ? 'dark' : 'light');
}
