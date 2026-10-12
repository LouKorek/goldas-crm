// Permissions are enforced in code (web, functions, Golda), never in
// firestore.rules. Every check in the system goes through can().

export const ROLES = ['admin', 'manager', 'viewer'] as const;
export type Role = typeof ROLES[number];

export const ACTIONS = [
  'read',             // view any record
  'edit',             // create / update records, attach files
  'delete',           // soft-delete a record (recycle bin)
  'restore',          // restore from the recycle bin
  'purge',            // permanently delete, clear a whole collection
  'run_sync',         // trigger syncs / watches (IFA, TM, IG)
  'manage_users',     // Team screen: add / remove / change roles
  'manage_settings',  // app-wide settings, integrations, backups
  'view_audit',       // read the audit log
] as const;
export type Action = typeof ACTIONS[number];

const MATRIX: Record<Role, ReadonlySet<Action>> = {
  admin:   new Set<Action>(ACTIONS),
  manager: new Set<Action>(['read', 'edit', 'delete', 'restore', 'run_sync', 'view_audit']),
  viewer:  new Set<Action>(['read']),
};

export const isRole = (v: unknown): v is Role => (ROLES as readonly string[]).includes(String(v));

/** Normalises anything stored as a role into a known Role (unknown -> viewer). */
export const normalizeRole = (v: unknown): Role => (isRole(v) ? v : 'viewer');

export const can = (role: unknown, action: Action): boolean =>
  MATRIX[normalizeRole(role)].has(action);

export const roleLabel = (role: unknown, lang: 'he' | 'en' = 'he'): string => {
  const r = normalizeRole(role);
  const he: Record<Role, string> = { admin: 'מנהל מערכת', manager: 'מנהל', viewer: 'צופה' };
  const en: Record<Role, string> = { admin: 'Admin', manager: 'Manager', viewer: 'Viewer' };
  return (lang === 'he' ? he : en)[r];
};
