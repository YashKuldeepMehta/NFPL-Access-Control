import React from 'react';
import { NavLink, Route, Routes, Navigate } from 'react-router-dom';
import { useUser } from './UserContext.jsx';
import UserSwitcher from './components/UserSwitcher.jsx';
import WorklistPage from './pages/WorklistPage.jsx';
import JobsPage from './pages/JobsPage.jsx';
import JobDetailPage from './pages/JobDetailPage.jsx';
import ExplainPage from './pages/ExplainPage.jsx';
import AccessPage from './pages/AccessPage.jsx';
import AuditPage from './pages/AuditPage.jsx';

export default function App() {
  const { user, error } = useUser();
  return (
    <div className="app">
      <header className="topbar">
        <h1>NFPL Access Control</h1>
        <nav>
          <NavLink to="/worklist">My work</NavLink>
          <NavLink to="/jobs">Jobs</NavLink>
          <NavLink to="/explain">Explain</NavLink>
          <NavLink to="/access">Access</NavLink>
          <NavLink to="/audit">Audit</NavLink>
        </nav>
        <UserSwitcher />
      </header>
      <main>
        {error && <div className="banner error">{error}</div>}
        {!user && !error && <p>Loading...</p>}
        {user && (
          // key = user id: everything reloads when you "become" someone else
          <Routes key={user.id}>
            <Route path="/" element={<Navigate to="/worklist" replace />} />
            <Route path="/worklist" element={<WorklistPage />} />
            <Route path="/jobs" element={<JobsPage />} />
            <Route path="/jobs/:id" element={<JobDetailPage />} />
            <Route path="/explain" element={<ExplainPage />} />
            <Route path="/access" element={<AccessPage />} />
            <Route path="/audit" element={<AuditPage />} />
          </Routes>
        )}
      </main>
    </div>
  );
}
