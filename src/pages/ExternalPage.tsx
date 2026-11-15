import { useEffect, useState } from 'react';
import { ExternalLink, Info, ShieldCheck, X } from 'lucide-react';
import type { BrowserTab } from '../types';
import { getHost } from '../utils/url';

interface ExternalPageProps {
  tab: BrowserTab;
  url: string;
  onLoaded: () => void;
  onFailed: () => void;
}

export function ExternalPage({ tab, url, onLoaded, onFailed }: ExternalPageProps) {
  const [showNotice, setShowNotice] = useState(true);
  const [showHelp, setShowHelp] = useState(false);

  useEffect(() => {
    setShowHelp(false);
    const timer = window.setTimeout(() => setShowHelp(true), 7000);
    return () => window.clearTimeout(timer);
  }, [url, tab.loadKey]);

  return (
    <div className="external-page">
      {showNotice && (
        <div className="embed-notice">
          <ShieldCheck size={16} />
          <span><strong>安全预览</strong> · {getHost(url)}</span>
          <span className="embed-notice__detail">部分网站会限制嵌入显示</span>
          <button type="button" onClick={() => window.open(url, '_blank', 'noopener,noreferrer')}>系统浏览器打开 <ExternalLink size={13} /></button>
          <button className="embed-notice__close" type="button" aria-label="关闭提示" onClick={() => setShowNotice(false)}><X size={14} /></button>
        </div>
      )}
      {showHelp && (
        <div className="embed-help" role="status">
          <Info size={16} /><span>页面空白或无法交互？该网站可能禁止嵌入。</span>
          <button type="button" onClick={() => window.open(url, '_blank', 'noopener,noreferrer')}>在新窗口打开</button>
          <button type="button" aria-label="关闭帮助" onClick={() => setShowHelp(false)}><X size={14} /></button>
        </div>
      )}
      <iframe
        key={`${url}-${tab.loadKey}`}
        className="web-frame"
        src={url}
        title={`网页内容：${url}`}
        onLoad={onLoaded}
        onError={onFailed}
        sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-downloads"
        referrerPolicy="strict-origin-when-cross-origin"
      />
    </div>
  );
}
