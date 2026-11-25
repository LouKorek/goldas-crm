import { createContext, useContext } from 'react';
import { can } from '@goldas/domain';

// Roles: 'admin' (owner — manages users), 'manager' (full edit), 'viewer' (read-only)
export const RoleContext = createContext({
  email: '', name: '', role: 'viewer',
  canEdit: false, isAdmin: false,
});

export const useRole = () => useContext(RoleContext);

/** Whether the signed-in person may do `action` (permissions.ts), e.g. useCan('money'). */
export const useCan = (action) => can(useContext(RoleContext).role, action);

export const roleLabel = (role) =>
  role === 'admin' ? 'Admin' : role === 'manager' ? 'Manager' : 'Viewer';
