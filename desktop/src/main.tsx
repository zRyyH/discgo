import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import * as Tooltip from '@radix-ui/react-tooltip';
import { App } from './App';
import './styles.css';

if (import.meta.env.DEV) {
  const q = new URLSearchParams(location.search);
  if (q.get('spike') === 'webview') void import('./spike/webviewCheck').then((m) => m.runWebviewCheck());
  if (q.get('spike') === 'scroll') void import('./spike/scrollCheck').then((m) => m.runScrollCheck(q.get('channel')!));
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Tooltip.Provider delayDuration={400} skipDelayDuration={200}>
      <App />
    </Tooltip.Provider>
  </StrictMode>,
);
