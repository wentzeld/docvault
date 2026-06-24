import { useUIStore } from '../store/ui';

export function useTheme() {
  const darkMode = useUIStore((s) => s.darkMode);
  const toggleDarkMode = useUIStore((s) => s.toggleDarkMode);
  return { darkMode, toggleDarkMode };
}
