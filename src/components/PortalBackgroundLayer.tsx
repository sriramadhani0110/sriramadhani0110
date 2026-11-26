import { useEffect, useState } from 'react';
import type { StoreBackgroundConfig } from '../types/marketplace';
import { clampBackgroundOpacity } from '../lib/storeDefaults';

interface PortalBackgroundLayerProps {
  config: StoreBackgroundConfig;
  baseClassName?: string;
  previewMode?: boolean;
}

const OPACITY_CLASS_MAP: Record<number, string> = {
  5: 'opacity-5',
  10: 'opacity-10',
  15: 'opacity-15',
  20: 'opacity-20',
  25: 'opacity-25',
  30: 'opacity-30',
  35: 'opacity-35',
  40: 'opacity-40',
  45: 'opacity-45',
  50: 'opacity-50',
  55: 'opacity-55',
  60: 'opacity-60',
  65: 'opacity-65',
  70: 'opacity-70',
  75: 'opacity-75',
  80: 'opacity-80',
  85: 'opacity-85',
};

const TILE_INDEXES = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] as const;

export function PortalBackgroundLayer({
  config,
  baseClassName = 'bg-[linear-gradient(135deg,#fee2e2_0%,#ffffff_42%,#ffffff_58%,#dbeafe_100%)]',
  previewMode = false,
}: PortalBackgroundLayerProps) {
  const [imageFailed, setImageFailed] = useState(false);

  useEffect(() => {
    setImageFailed(false);
  }, [config.imageUrl]);

  const opacityKey = clampBackgroundOpacity(config.opacity, 20);
  const opacityClass = OPACITY_CLASS_MAP[opacityKey] ?? 'opacity-20';
  const shouldShowImage = Boolean(config.enabled && config.imageUrl && !imageFailed);

  const containerPosition = previewMode
    ? 'absolute inset-0 pointer-events-none z-0 overflow-hidden select-none'
    : 'fixed inset-0 pointer-events-none z-0 overflow-hidden select-none no-print';

  return (
    <div aria-hidden="true" className={`${containerPosition} ${baseClassName}`}>
      {shouldShowImage && config.displayMode === 'cover' && (
        <img
          src={config.imageUrl}
          alt=""
          referrerPolicy="no-referrer"
          onError={() => setImageFailed(true)}
          className={`w-full h-full object-cover object-center ${opacityClass} transition-opacity duration-300`}
        />
      )}

      {shouldShowImage && config.displayMode === 'watermark_center' && (
        <div className="w-full h-full flex items-center justify-center p-6 sm:p-12">
          <img
            src={config.imageUrl}
            alt=""
            referrerPolicy="no-referrer"
            onError={() => setImageFailed(true)}
            className={`${
              previewMode
                ? 'max-w-[72%] max-h-[72%]'
                : 'w-[78vw] sm:w-[56vw] lg:w-[44vw] max-w-[640px] max-h-[72vh]'
            } object-contain rounded-3xl mix-blend-multiply ${opacityClass} transition-opacity duration-300`}
          />
        </div>
      )}

      {shouldShowImage && config.displayMode === 'watermark_tile' && (
        <div
          className={`w-full h-full grid ${
            previewMode
              ? 'grid-cols-3 grid-rows-2 gap-4 p-4'
              : 'grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-8 sm:gap-10 p-6 sm:p-10'
          } items-center justify-items-center ${opacityClass} transition-opacity duration-300`}
        >
          {TILE_INDEXES.slice(0, previewMode ? 6 : 12).map((idx) => (
            <img
              key={idx}
              src={config.imageUrl}
              alt=""
              referrerPolicy="no-referrer"
              onError={idx === 0 ? () => setImageFailed(true) : undefined}
              className={`${
                previewMode ? 'w-24 h-20' : 'w-40 sm:w-48 lg:w-56 max-h-40'
              } object-contain rounded-2xl mix-blend-multiply`}
            />
          ))}
        </div>
      )}
    </div>
  );
}
