import React from 'react';
import { createRoot } from 'react-dom/client';
import type { LingVoiceApi } from '../shared/contracts';
import { App } from './App';

async function bootstrap(): Promise<void> {
  const bridge: LingVoiceApi | undefined = window.lingvoice;
  if (import.meta.env.DEV && !bridge) {
    const { installWebMock } = await import('./web-mock');
    installWebMock();
  }
  const root = document.getElementById('root');
  if (!root) throw new Error('缺少 React 挂载节点。');
  createRoot(root).render(<React.StrictMode><App /></React.StrictMode>);
}

void bootstrap();