import { useEffect, useState } from 'react';
import { Package } from 'lucide-react';

interface ProductImageProps {
  src: string;
  alt: string;
  className?: string;
  onDimensionsLoad?: (dims: { width: number; height: number }) => void;
}

export function ProductImage({
  src,
  alt,
  className = '',
  onDimensionsLoad,
}: ProductImageProps) {
  const [hasError, setHasError] = useState(false);

  useEffect(() => {
    setHasError(false);
  }, [src]);

  if (!src || hasError) {
    return (
      <div
        className={`flex flex-col items-center justify-center gap-2 bg-gradient-to-br from-slate-100 to-slate-200 text-slate-500 p-4 text-center ${className}`}
        role="img"
        aria-label={alt}
      >
        <Package className="w-8 h-8 text-slate-400" strokeWidth={1.5} />
        <span className="text-xs font-medium text-slate-600 line-clamp-2 max-w-[180px]">
          {alt}
        </span>
      </div>
    );
  }

  return (
    <img
      src={src}
      alt={alt}
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
      onLoad={(e) => {
        const img = e.currentTarget;
        if (onDimensionsLoad && img.naturalWidth > 0 && img.naturalHeight > 0) {
          onDimensionsLoad({
            width: img.naturalWidth,
            height: img.naturalHeight,
          });
        }
      }}
      onError={() => setHasError(true)}
      className={className}
    />
  );
}
