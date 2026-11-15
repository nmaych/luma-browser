import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App';
import { DownloadsPage } from './pages/DownloadsPage';
import './styles/base.css';
import './styles/browser.css';
import './styles/pages.css';
import './styles/downloads.css';
import './styles/responsive.css';

const isDownloadsWindow = new URLSearchParams(window.location.search).get('downloads') === '1';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {isDownloadsWindow ? <DownloadsPage /> : <App />}
  </StrictMode>,
);
