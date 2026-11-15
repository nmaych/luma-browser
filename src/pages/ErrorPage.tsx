import { ArrowLeft, CloudOff, ExternalLink, Globe2, RefreshCw } from 'lucide-react';
import type { BrowserError } from '../types';

interface ErrorPageProps {
  error: BrowserError;
  url: string;
  canGoBack: boolean;
  onRetry: () => void;
  onBack: () => void;
  onHome: () => void;
}

export function ErrorPage({ error, url, canGoBack, onRetry, onBack, onHome }: ErrorPageProps) {
  return (
    <div className="error-page page-scroll">
      <div className="error-card">
        <div className="error-illustration">
          <div className="error-globe"><Globe2 size={52} /></div>
          <span><CloudOff size={24} /></span>
        </div>
        <p className="error-code">{error.type === 'offline' ? 'ERR_INTERNET_DISCONNECTED' : 'ERR_PAGE_UNREACHABLE'}</p>
        <h1>{error.title}</h1>
        <p className="error-message">{error.message}</p>
        <code title={url}>{url}</code>
        <div className="error-actions">
          <button className="primary-button" type="button" onClick={onRetry}><RefreshCw size={17} /> 重新加载</button>
          {canGoBack ? <button className="secondary-button" type="button" onClick={onBack}><ArrowLeft size={17} /> 返回上一页</button> : <button className="secondary-button" type="button" onClick={onHome}>回到主页</button>}
        </div>
        <button className="text-button" type="button" onClick={() => window.open(url, '_blank', 'noopener,noreferrer')}>
          在系统浏览器中尝试打开 <ExternalLink size={14} />
        </button>
        <div className="error-tips"><strong>你可以尝试：</strong><ul><li>检查网络连接和代理设置</li><li>确认网址拼写是否正确</li><li>稍后再试，部分网站可能暂时不可用</li></ul></div>
      </div>
    </div>
  );
}
