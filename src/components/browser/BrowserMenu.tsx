import { BookOpen, Camera, Check, Clock3, Code2, Download, EyeOff, FileDown, Maximize, MoreVertical, Plus, Printer, RotateCcw, Settings2, Star, Wifi, WifiOff } from 'lucide-react';
import { getAllSearchEngines } from '../../data/searchEngines';
import type { CustomSearchEngine, SearchEngine } from '../../types';
import { IconButton } from '../common/IconButton';
import { SearchEngineMark } from '../common/SearchEngineMark';

interface BrowserMenuProps {
  open: boolean;
  isOnline: boolean;
  canReopen: boolean;
  searchEngine: SearchEngine;
  customSearchEngines?: CustomSearchEngine[];
  onSearchEngineChange: (engine: SearchEngine) => void;
  onToggle: () => void;
  onClose: () => void;
  onNewTab: () => void;
  onReopen: () => void;
  onDownloads?: () => void;
  onIncognito?: () => void;
  downloadCount?: number;
  onBookmarks: () => void;
  onHistory: () => void;
  onBookmark: () => void;
  onSettings: () => void;
  onFullscreen?: () => void;
  onDevTools?: () => void;
  onPrint?: () => void;
  onSavePdf?: () => void;
  onScreenshot?: () => void;
}

export function BrowserMenu(props: BrowserMenuProps) {
  const action = (callback: () => void) => () => {
    callback();
    props.onClose();
  };

  return (
    <div className="browser-menu-anchor">
      <IconButton label="自定义及控制 Luma" active={props.open} onClick={props.onToggle}>
        <MoreVertical size={19} />
      </IconButton>
      {props.open && (
        <>
          <button className="popover-dismiss" type="button" aria-label="关闭菜单" onClick={props.onClose} />
          <div className="browser-menu popover">
            <button type="button" onClick={action(props.onNewTab)}><Plus />新建标签页<span>Ctrl + T</span></button>
            {props.onIncognito && (
              <button type="button" onClick={action(props.onIncognito)}><EyeOff />新建无痕窗口<span>Ctrl + Shift + N</span></button>
            )}
            <button type="button" onClick={action(props.onReopen)} disabled={!props.canReopen}><RotateCcw />恢复标签页<span>Ctrl + Shift + T</span></button>
            {props.onDownloads && (
              <button type="button" onClick={action(props.onDownloads)}>
                <Download />下载内容<span>Ctrl + J</span>
                {Boolean(props.downloadCount) && <em className="menu-count">{props.downloadCount}</em>}
              </button>
            )}
            {props.onPrint && (
              <button type="button" onClick={action(props.onPrint)}><Printer />打印<span>Ctrl + P</span></button>
            )}
            {props.onSavePdf && (
              <button type="button" onClick={action(props.onSavePdf)}><FileDown />另存为 PDF</button>
            )}
            {props.onScreenshot && (
              <button type="button" onClick={action(props.onScreenshot)}><Camera />网页截图<span>Ctrl + Shift + X</span></button>
            )}
            <div className="menu-divider" />
            <button type="button" onClick={action(props.onBookmarks)}><BookOpen />书签管理器</button>
            <button type="button" onClick={action(props.onHistory)}><Clock3 />历史记录<span>Ctrl + H</span></button>
            <button type="button" onClick={action(props.onBookmark)}><Star />为此页添加书签<span>Ctrl + D</span></button>
            <div className="menu-divider" />
            {props.onFullscreen && (
              <button type="button" onClick={action(props.onFullscreen)}><Maximize />全屏<span>F11</span></button>
            )}
            {props.onDevTools && (
              <button type="button" onClick={action(props.onDevTools)}><Code2 />开发者工具<span>F12</span></button>
            )}
            <button type="button" onClick={action(props.onSettings)}><Settings2 />设置</button>
            <div className="menu-engine">
              <span className="menu-engine__label">默认搜索引擎</span>
              <div className="menu-engine__options">
                {getAllSearchEngines(props.customSearchEngines).map((engine) => (
                  <button
                    type="button"
                    key={engine.id}
                    className={props.searchEngine === engine.id ? 'is-active' : ''}
                    aria-pressed={props.searchEngine === engine.id}
                    aria-label={`使用${engine.name}搜索`}
                    onClick={() => props.onSearchEngineChange(engine.id)}
                  >
                    <SearchEngineMark engine={engine.id} customEngines={props.customSearchEngines} size="small" />
                    <span>{engine.name}</span>
                    {props.searchEngine === engine.id && <Check size={11} />}
                  </button>
                ))}
              </div>
            </div>
            <div className={`menu-network ${props.isOnline ? '' : 'is-offline'}`}>
              {props.isOnline ? <Wifi size={14} /> : <WifiOff size={14} />}
              {props.isOnline ? '网络连接正常' : '当前处于离线状态'}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
