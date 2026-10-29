import React, { createContext, useContext, useEffect, useState } from 'react';
import { api, setApiUser } from './api.js';

const Ctx = createContext(null);
export const useUser = () => useContext(Ctx);

export function UserProvider({ children }) {
  const [users, setUsers] = useState([]);
  const [user, setUser] = useState(null);
  const [ref, setRef] = useState({ clients: [], branches: [] });
  const [error, setError] = useState(null);

  useEffect(() => {
    (async () => {
      try {
        const [u, r] = await Promise.all([api('/dev/users'), api('/dev/ref')]);
        setUsers(u.items);
        setRef(r);
        const saved = Number(localStorage.getItem('nfpl_user'));
        const first = u.items.find((x) => x.id === saved) ?? u.items[0];
        if (first) { setApiUser(first.id); setUser(first); }
      } catch (e) {
        setError('Cannot reach the backend. Is it running on port 3000? (' + e.message + ')');
      }
    })();
  }, []);

  const switchUser = (id) => {
    const u = users.find((x) => x.id === Number(id));
    if (!u) return;
    setApiUser(u.id);
    localStorage.setItem('nfpl_user', String(u.id));
    setUser(u);
  };

  return <Ctx.Provider value={{ users, user, switchUser, ref, error }}>{children}</Ctx.Provider>;
}
