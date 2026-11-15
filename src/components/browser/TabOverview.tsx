import { Plus, X } from 'lucide-react';
import type { BrowserTab } from '../../types';
import { displayUrl } from '../../utils/url';
import { IconButton } from '../common/IconButton';
import { Modal } from '../common/Modal';
import { SiteIcon } from '../common/SiteIcon';

interface TabOverviewProps {
  tabs: BrowserTab[];
  activeTabId: string;
  previews?: Record<string, string>;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onNew: () => void;
  onDismiss: () => void;
}

export function TabOverview(props: TabOverviewProps) {
  return (
    <Modal title="标签页" description={`${props.tabs.length} 个打开的标签页`} onClose={props.onDismiss} className="tab-overview-modal">
      <div className="tab-overview-grid">
        {props.tabs.map((tab) => {
          const entry = tab.entries[tab.historyIndex];
          const preview = props.previews?.[tab.id];
          return (
            <article className={`tab-card ${tab.id === props.activeTabId ? 'is-active' : ''}`} key={tab.id}>
              <button
                className="tab-card__select"
                type="button"
                onClick={() => { props.onSelect(tab.id); props.onDismiss(); }}
              >
                <div className={`tab-card__preview ${preview ? 'has-preview' : ''}`}>
                  <span className="preview-dots"><i /><i /><i /></span>
                  {preview ? <img className="tab-card__preview-image" src={preview} alt="" /> : <SiteIcon url={entry.url} size="large" favicon={tab.favicon} />}
                </div>
                <div className="tab-card__info">
                  <SiteIcon url={entry.url} size="small" favicon={tab.favicon} />
                  <div><strong>{entry.title}</strong><span>{displayUrl(entry.url) || '新标签页'}</span></div>
                </div>
              </button>
              <IconButton className="tab-card__close" size="small" label={`关闭 ${entry.title}`} onClick={() => props.onClose(tab.id)}>
                <X size={15} />
              </IconButton>
            </article>
          );
        })}
        <button className="tab-card tab-card--new" type="button" onClick={() => { props.onNew(); props.onDismiss(); }}>
          <Plus size={24} /><span>新建标签页</span>
        </button>
      </div>
    </Modal>
  );
}
