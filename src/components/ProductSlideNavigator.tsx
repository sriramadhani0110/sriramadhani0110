import { useEffect, useMemo, useRef, useState, type ReactNode, type TouchEvent } from 'react';
import { ChevronLeft, ChevronRight, Hand } from 'lucide-react';

interface ProductSlideNavigatorProps<T> {
  items: T[];
  itemsPerSlide?: number;
  mobileItemsPerSlide?: number;
  resetKey?: string;
  label?: string;
  renderGrid: (slideItems: T[], slideIndex: number) => ReactNode;
}

function useIsCompactViewport(): boolean {
  const [isCompact, setIsCompact] = useState<boolean>(() =>
    typeof window !== 'undefined' ? window.innerWidth < 768 : false
  );

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const mq = window.matchMedia('(max-width: 767px)');
    const sync = () => setIsCompact(mq.matches);
    sync();
    if (typeof mq.addEventListener === 'function') {
      mq.addEventListener('change', sync);
      return () => mq.removeEventListener('change', sync);
    }
    mq.addListener(sync);
    return () => mq.removeListener(sync);
  }, []);

  return isCompact;
}

export function ProductSlideNavigator<T>({
  items,
  itemsPerSlide = 30,
  mobileItemsPerSlide = 30,
  resetKey = '',
  label = 'Produk',
  renderGrid,
}: ProductSlideNavigatorProps<T>) {
  const isCompact = useIsCompactViewport();
  const effectivePerSlide = Math.max(
    1,
    Math.trunc(isCompact ? mobileItemsPerSlide : itemsPerSlide)
  );
  const totalSlides = Math.max(1, Math.ceil(items.length / effectivePerSlide));
  const [currentSlide, setCurrentSlide] = useState(0);
  const touchStartXRef = useRef<number | null>(null);
  const touchStartYRef = useRef<number | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setCurrentSlide(0);
  }, [resetKey]);

  useEffect(() => {
    if (currentSlide >= totalSlides) {
      setCurrentSlide(Math.max(0, totalSlides - 1));
    }
  }, [currentSlide, totalSlides]);

  const activeSlide = Math.min(currentSlide, totalSlides - 1);
  const startIdx = activeSlide * effectivePerSlide;
  const endIdx = Math.min(items.length, startIdx + effectivePerSlide);
  const slideItems = useMemo(
    () => items.slice(startIdx, endIdx),
    [items, startIdx, endIdx]
  );

  const goToSlide = (nextIdx: number, scrollIfNeeded = true) => {
    const clamped = Math.max(0, Math.min(totalSlides - 1, nextIdx));
    if (clamped === activeSlide) return;
    setCurrentSlide(clamped);
    if (scrollIfNeeded && containerRef.current) {
      const rect = containerRef.current.getBoundingClientRect();
      if (rect.top < 72) {
        containerRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    }
  };

  const handleTouchStart = (e: TouchEvent<HTMLDivElement>) => {
    if (totalSlides <= 1) return;
    const touch = e.touches[0];
    if (!touch) return;
    touchStartXRef.current = touch.clientX;
    touchStartYRef.current = touch.clientY;
  };

  const handleTouchEnd = (e: TouchEvent<HTMLDivElement>) => {
    if (totalSlides <= 1) return;
    const startX = touchStartXRef.current;
    const startY = touchStartYRef.current;
    touchStartXRef.current = null;
    touchStartYRef.current = null;
    if (startX === null || startY === null) return;
    const touch = e.changedTouches[0];
    if (!touch) return;
    const dx = touch.clientX - startX;
    const dy = touch.clientY - startY;
    if (Math.abs(dx) >= 42 && Math.abs(dx) > Math.abs(dy) * 1.15) {
      if (dx < 0 && activeSlide < totalSlides - 1) {
        goToSlide(activeSlide + 1, false);
      } else if (dx > 0 && activeSlide > 0) {
        goToSlide(activeSlide - 1, false);
      }
    }
  };

  // Compute compact numbered slide sequence (e.g. [0, 1, 2, 'ellipsis-right', 9])
  const pageTokens = useMemo<Array<number | 'ellipsis-left' | 'ellipsis-right'>>(() => {
    if (totalSlides <= 7) {
      return Array.from({ length: totalSlides }, (_, idx) => idx);
    }
    const tokens: Array<number | 'ellipsis-left' | 'ellipsis-right'> = [0];
    const windowStart = Math.max(1, activeSlide - 1);
    const windowEnd = Math.min(totalSlides - 2, activeSlide + 1);

    if (windowStart > 1) {
      tokens.push('ellipsis-left');
    }
    for (let i = windowStart; i <= windowEnd; i++) {
      tokens.push(i);
    }
    if (windowEnd < totalSlides - 2) {
      tokens.push('ellipsis-right');
    }
    tokens.push(totalSlides - 1);
    return tokens;
  }, [activeSlide, totalSlides]);

  const renderSlideBar = (position: 'top' | 'bottom') => {
    if (items.length === 0) return null;
    return (
      <div
        className={`flex flex-col sm:flex-row sm:items-center justify-between gap-2.5 bg-white border border-slate-200 rounded-xl px-3.5 py-2.5 shadow-sm ${
          position === 'top' ? 'mb-4' : 'mt-5'
        }`}
      >
        <div className="flex items-center justify-between sm:justify-start gap-2 text-xs text-slate-600 flex-wrap">
          <span className="font-mono font-bold text-white bg-blue-700 px-2.5 py-0.5 rounded-md">
            Slide {activeSlide + 1} / {totalSlides}
          </span>
          <span className="text-[11px] sm:text-xs text-slate-600">
            Menampilkan <span className="font-semibold text-slate-900">{startIdx + 1}–{endIdx}</span> dari{' '}
            <span className="font-semibold text-slate-900">{items.length}</span> {label.toLowerCase()}
          </span>
          {totalSlides > 1 && (
            <span className="inline-flex items-center gap-1 text-[11px] font-medium text-blue-700 bg-blue-50 border border-blue-200 px-2 py-0.5 rounded-md">
              <Hand className="w-3 h-3 shrink-0" />
              <span>Geser / pilih nomor slide</span>
            </span>
          )}
        </div>

        <div className="flex items-center justify-center sm:justify-end gap-1.5 flex-wrap">
          <button
            type="button"
            onClick={() => goToSlide(activeSlide - 1)}
            disabled={activeSlide === 0}
            aria-label="Slide sebelumnya"
            className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-semibold border border-slate-300 bg-white text-slate-700 hover:bg-blue-50 hover:border-blue-300 hover:text-blue-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors cursor-pointer"
          >
            <ChevronLeft className="w-3.5 h-3.5" />
            <span>Prev</span>
          </button>

          <div className="flex items-center gap-1 overflow-x-auto max-w-full py-0.5">
            {pageTokens.map((token) => {
              if (token === 'ellipsis-left' || token === 'ellipsis-right') {
                return (
                  <span
                    key={token}
                    className="px-1.5 text-xs font-mono text-slate-400 select-none"
                  >
                    ...
                  </span>
                );
              }
              const isCurrent = token === activeSlide;
              return (
                <button
                  key={token}
                  type="button"
                  onClick={() => goToSlide(token)}
                  aria-label={`Slide nomor ${token + 1}`}
                  aria-current={isCurrent ? 'page' : undefined}
                  className={`min-w-[34px] h-8 px-2.5 rounded-lg text-xs font-mono font-bold transition-colors cursor-pointer ${
                    isCurrent
                      ? 'bg-red-600 text-white shadow-sm ring-2 ring-red-200'
                      : 'bg-slate-50 text-slate-700 border border-slate-200 hover:bg-blue-50 hover:border-blue-300 hover:text-blue-700'
                  }`}
                >
                  {token + 1}
                </button>
              );
            })}
          </div>

          <button
            type="button"
            onClick={() => goToSlide(activeSlide + 1)}
            disabled={activeSlide >= totalSlides - 1}
            aria-label="Slide berikutnya"
            className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-semibold border border-slate-300 bg-white text-slate-700 hover:bg-blue-50 hover:border-blue-300 hover:text-blue-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors cursor-pointer"
          >
            <span>Next</span>
            <ChevronRight className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
    );
  };

  return (
    <div
      ref={containerRef}
      onTouchStart={handleTouchStart}
      onTouchEnd={handleTouchEnd}
      className="scroll-mt-20"
    >
      {renderSlideBar('top')}
      <div>{renderGrid(slideItems, activeSlide)}</div>
      {renderSlideBar('bottom')}
    </div>
  );
}
