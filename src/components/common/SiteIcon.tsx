import { useState } from 'react';
import { Clock3, Settings2, Star } from 'lucide-react';
import { getDefaultFavicon, getFaviconLetter, getInternalPage } from '../../utils/url';
import { Logo } from './Logo';

interface SiteIconProps {
  url: string;
  size?: 'small' | 'medium' | 'large';
  favicon?: string;
}

export function SiteIcon({ url, size = 'medium', favicon }: SiteIconProps) {
  const [failedFavicon, setFailedFavicon] = useState<string | null>(null);
  const page = getInternalPage(url);
  if (page === 'home' || page === 'newtab') return <Logo size={size === 'small' ? 19 : size === 'large' ? 42 : 28} />;

  const usableFavicon = favicon && favicon !== 'data:,' ? favicon : undefined;
  const resolvedFavicon = page ? undefined : usableFavicon || getDefaultFavicon(url);
  const showFavicon = Boolean(resolvedFavicon) && failedFavicon !== resolvedFavicon;
  const content = page === 'bookmarks' ? <Star /> : page === 'history' ? <Clock3 /> : page === 'settings' ? <Settings2 /> : getFaviconLetter(url);
  const colorIndex = [...url].reduce((total, char) => total + char.charCodeAt(0), 0) % 5;

  return (
    <span
      className={`site-icon site-icon--${size} ${page ? 'site-icon--internal' : showFavicon ? 'site-icon--favicon' : `site-icon--color-${colorIndex}`}`}
      aria-hidden="true"
    >
      {showFavicon ? (
        <img key={resolvedFavicon} src={resolvedFavicon} alt="" loading="lazy" onError={() => setFailedFavicon(resolvedFavicon ?? null)} />
      ) : content}
    </span>
  );
}
