import { ArrowLeft, ArrowRight, Home, RotateCw, X } from 'lucide-react';
import { IconButton } from '../common/IconButton';

interface MobileNavigationProps {
  canBack: boolean;
  canForward: boolean;
  isLoading: boolean;
  tabCount: number;
  onBack: () => void;
  onForward: () => void;
  onRefresh: () => void;
  onStop: () => void;
  onHome: () => void;
  onTabs: () => void;
}

export function MobileNavigation(props: MobileNavigationProps) {
  return (
    <nav className="mobile-navigation" aria-label="移动端浏览器导航">
      <IconButton label="后退" onClick={props.onBack} disabled={!props.canBack}><ArrowLeft /></IconButton>
      <IconButton label="前进" onClick={props.onForward} disabled={!props.canForward}><ArrowRight /></IconButton>
      <IconButton label={props.isLoading ? '停止加载' : '刷新'} onClick={props.isLoading ? props.onStop : props.onRefresh}>
        {props.isLoading ? <X /> : <RotateCw />}
      </IconButton>
      <IconButton label="主页" onClick={props.onHome}><Home /></IconButton>
      <button className="mobile-tab-count" type="button" onClick={props.onTabs} aria-label={`管理 ${props.tabCount} 个标签页`}>
        <span>{props.tabCount > 99 ? '99+' : props.tabCount}</span>
      </button>
    </nav>
  );
}
