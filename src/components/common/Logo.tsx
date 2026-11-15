import { useId } from 'react';

interface LogoProps {
  size?: number;
  withWordmark?: boolean;
  className?: string;
}

export function Logo({ size = 32, withWordmark = false, className = '' }: LogoProps) {
  const gradientId = useId();
  return (
    <span className={`brand-logo ${className}`} aria-label="Luma Browser">
      <svg width={size} height={size} viewBox="0 0 64 64" fill="none" aria-hidden="true">
        <defs>
          <linearGradient id={gradientId} x1="8" y1="6" x2="55" y2="58" gradientUnits="userSpaceOnUse">
            <stop stopColor="#9488ff" />
            <stop offset="1" stopColor="#585de8" />
          </linearGradient>
        </defs>
        <rect width="64" height="64" rx="19" fill={`url(#${gradientId})`} />
        <path d="M18 17h11v23c0 4 2 6 6 6h12v9H34c-11 0-16-6-16-16V17Z" fill="white" />
        <circle cx="43" cy="22" r="6" fill="#c8f5df" />
      </svg>
      {withWordmark && <span className="brand-wordmark">luma</span>}
    </span>
  );
}
