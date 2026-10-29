import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';

if (import.meta.env.DEV && new URLSearchParams(location.search).get('spike') === 'webview') {
  void import('./spike/webviewCheck').then((m) => m.runWebviewCheck());
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
