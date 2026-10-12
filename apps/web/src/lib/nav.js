// The navigation, defined once. The sidebar, the mobile index, the bottom
// bar and the global search all read this list, so a screen is added in one
// place. Seven areas, in the order the agency works: home, players, market,
// clubs, calendar, scouting, Golda, plus admin.
import { t } from './i18n';

export const AREAS = [
  {
    key: 'home', label: t('Home'), icon: 'dashboard', path: '/home',
    items: [
      { label: t('Today'), path: '/home/today' },
      { label: t('Snapshot'), path: '/home/snapshot' },
    ],
  },
  {
    key: 'players', label: t('Players'), icon: 'players', path: '/players',
    items: [
      { label: t('Represented'), path: '/players' },
    ],
  },
  {
    key: 'market', label: t('Market'), icon: 'clipboard', path: '/market/prospects',
    items: [
      { label: t('Candidates'), path: '/market/prospects', icon: 'players' },
      { label: t('Club Requirements'), path: '/market/requirements', icon: 'clipboard' },
      { label: t('Deals'), path: '/market/deals', icon: 'tasks' },
      { label: t('Men'), path: '/pipeline/men', icon: 'men' },
      { label: t('Women'), path: '/pipeline/women', icon: 'women' },
      { label: t('Youth'), path: '/pipeline/youth', icon: 'youth' },
      { label: t('Jewish abroad'), path: '/pipeline/jewish', icon: 'star' },
    ],
  },
  {
    key: 'clubs', label: t('Clubs'), icon: 'contacts', path: '/clubs',
    items: [
      { label: t('Clubs'), path: '/clubs' },
      { label: t('Contacts'), path: '/contacts', icon: 'contacts' },
    ],
  },
  {
    key: 'calendar', label: t('Calendar'), icon: 'matches', path: '/calendar',
    items: [
      { label: t('Calendar'), path: '/calendar' },
      { label: t('Matches'), path: '/matches' },
    ],
  },
  {
    key: 'scouting', label: t('Scouting'), icon: 'search', path: '/pipeline/jewish/tm-watch',
    items: [
      { label: t('TM Watch'), path: '/pipeline/jewish/tm-watch', icon: 'star' },
    ],
  },
  {
    key: 'golda', label: t('Golda'), icon: 'chat', path: '/golda',
    items: [{ label: t('Golda'), path: '/golda' }],
  },
  {
    key: 'admin', label: t('Admin'), icon: 'team', path: '/tasks',
    items: [
      { label: t('My Tasks'), path: '/tasks', icon: 'tasks' },
      { label: t('Notifications'), path: '/notifications', icon: 'bell' },
      // The agency's own Instagram account (followers, post impact).
      { label: t('Agency Instagram'), path: '/social', icon: 'social' },
      { label: t('Recycle Bin'), path: '/recycle', icon: 'trash' },
      { label: t('Team'), path: '/team', icon: 'team', adminOnly: true },
      { label: t('Data Migrations'), path: '/admin/migrations', icon: 'refresh', adminOnly: true },
    ],
  },
];

/** The five destinations of the phone's bottom bar; "More" opens the index. */
export const BOTTOM = [
  { key: 'home', label: t('Home'), icon: 'dashboard', path: '/home' },
  { key: 'players', label: t('Players'), icon: 'players', path: '/players' },
  { key: 'market', label: t('Market'), icon: 'clipboard', path: '/market/prospects' },
  { key: 'golda', label: t('Golda'), icon: 'chat', path: '/golda' },
  { key: 'more', label: t('More'), icon: 'menu', path: '__more__' },
];

/** Flat list of every destination (for search and the mobile index). */
export const DESTINATIONS = AREAS.flatMap((a) => a.items.map((i) => ({ ...i, area: a.key, icon: i.icon || a.icon })));

/** Which area a pathname belongs to. */
export function areaOf(pathname) {
  if (pathname.startsWith('/home') || pathname === '/dashboard') return 'home';
  if (pathname.startsWith('/pipeline/jewish/tm-watch')) return 'scouting';
  if (pathname.startsWith('/pipeline') || pathname.startsWith('/requirements') || pathname.startsWith('/market')) return 'market';
  if (pathname.startsWith('/players')) return 'players';
  if (pathname.startsWith('/matches') || pathname.startsWith('/calendar')) return 'calendar';
  if (pathname.startsWith('/clubs') || pathname.startsWith('/contacts')) return 'clubs';
  if (pathname.startsWith('/golda')) return 'golda';
  return 'admin';
}

export const visibleItems = (items, { isAdmin }) => items.filter((i) => !i.adminOnly || isAdmin);
