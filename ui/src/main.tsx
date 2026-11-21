import React from 'react';
import { createRoot } from 'react-dom/client';
import './app.css';
import App from './App';
import { setApiTransport } from './api';

async function start() {
  // `npm run dev` with ?mock: the API mock instead of a running `langflow web` (dev builds only).
  if (import.meta.env.DEV && new URLSearchParams(location.search).has('mock')) setApiTransport((await import('./mock/mock')).mockTransport);
  createRoot(document.getElementById('root')!).render(<React.StrictMode><App shell="web" /></React.StrictMode>);
}
void start();
