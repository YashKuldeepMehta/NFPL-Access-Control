import React from 'react';
import { useUser } from '../UserContext.jsx';

// Identity is simulated for this assignment: pick who you are "logged in" as.
export default function UserSwitcher() {
  const { users, user, switchUser } = useUser();
  if (!user) return null;
  return (
    <label className="switcher">
      Acting as{' '}
      <select value={user.id} onChange={(e) => switchUser(e.target.value)}>
        {users.map((u) => (
          <option key={u.id} value={u.id}>{u.name} ({u.type})</option>
        ))}
      </select>
    </label>
  );
}
