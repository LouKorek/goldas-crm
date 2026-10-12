import { createContext, useContext } from 'react';

// Roles: 'admin' (owner — manages users), 'manager' (full edit), 'viewer' (read-only)
export const RoleContext = createContext({
  email: '', name: '', role: 'viewer',
  canEdit: false, isAdmin: false,
});

export const useRole = () => useContext(RoleContext);

export const roleLabel = (role) =>
  role === 'admin' ? 'Admin' : role === 'manager' ? 'Manager' : 'Viewer';
