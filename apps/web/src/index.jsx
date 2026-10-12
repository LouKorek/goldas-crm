import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { applyDocumentLang } from './lib/i18n';

// Language and direction are set before the first paint, so Hebrew never
// flashes left-to-right.
applyDocumentLang();

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode><App /></React.StrictMode>
);
