import React from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { useTheme } from '../hooks/useTheme';
import { apiClient } from '../api/client';

interface LayoutProps {
  children: React.ReactNode;
  onLogout: () => void;
}

export function Layout({ children, onLogout }: LayoutProps) {
  const { darkMode, toggleDarkMode } = useTheme();
  const navigate = useNavigate();

  const handleLogout = async () => {
    await apiClient.post('/auth/logout', {}).catch(() => {});
    onLogout();
    navigate('/login');
  };

  return (
    <div className="layout">
      <nav className="sidebar">
        <div className="sidebar-header">
          <NavLink to="/" className="sidebar-brand">
            <span>📄</span>
            <span>DocVault</span>
          </NavLink>
        </div>

        <div className="sidebar-nav">
          <NavLink
            to="/"
            end
            className={({ isActive }) =>
              `nav-link${isActive ? ' active' : ''}`
            }
          >
            <span>📋</span>
            <span>Documents</span>
          </NavLink>
          <NavLink
            to="/search"
            className={({ isActive }) =>
              `nav-link${isActive ? ' active' : ''}`
            }
          >
            <span>🔍</span>
            <span>Search</span>
          </NavLink>
        </div>

        <div className="sidebar-footer">
          <button
            className="btn btn-ghost btn-sm w-full"
            onClick={toggleDarkMode}
            style={{ marginBottom: 8, justifyContent: 'flex-start' }}
          >
            {darkMode ? '☀️' : '🌙'}{' '}
            {darkMode ? 'Light mode' : 'Dark mode'}
          </button>
          <button
            className="btn btn-ghost btn-sm w-full"
            onClick={handleLogout}
            style={{ justifyContent: 'flex-start' }}
          >
            <span>🚪</span>
            <span>Log out</span>
          </button>
        </div>
      </nav>

      <main className="main-content">{children}</main>
    </div>
  );
}
