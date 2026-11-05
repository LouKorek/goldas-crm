import { createContext, useContext } from 'react';

// What the app shell shares with the screens: the global search opener and
// the number on the bell. PageHeader uses it on the phone, where the search
// and bell buttons sit in the page's own top row (no separate app bar).
export const ShellContext = createContext({ openSearch: () => {}, alertCount: 0 });
export const useShell = () => useContext(ShellContext);
