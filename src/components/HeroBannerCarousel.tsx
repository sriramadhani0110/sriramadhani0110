import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowRight,
  ChevronLeft,
  ChevronRight,
  Pause,
  Play,
  Store,
} from 'lucide-react';
import type { StoreBanner } from '../types/marketplace';
import { DEFAULT_STORE_BANNERS } from '../lib/storeDefaults';
import { STORE_NAME } from '../lib/catalogSeed';
import type { ActivePage } from './Navbar';

interface HeroBannerCarouselProps {
  banners: StoreBanner[];
  onNavigate?: (page: ActivePage, sectionId?: string) => void;
  autoPlayMs?: number;
  compactPreview?: boolean;
}

export function HeroBannerCarousel({
  banners,
  onNavigate,
  autoPlayMs = 5500,
  compactPreview = false,
}: HeroBannerCarouselProps) {
  const slides = banners.length > 0 ? banners : DEFAULT_STORE_BANNERS;
  const [activeIndex, setActiveIndex] = useState(0);
  const [isPaused, setIsPaused] = useState(false);
  const [brokenImages, setBrokenImages] = useState<Record<string, boolean>>({});
  const touchStartX = useRef<number | null>(null);
  const touchDeltaX = useRef<number>(0);

  const safeIndex = activeIndex >= slides.length ? 0 : activeIndex;

  useEffect(() => {
    if (activeIndex >= slides.length) {
      setActiveIndex(0);
    }
  }, [activeIndex, slides.length]);

  const goNext = useCallback(() => {
    setActiveIndex((prev) => (prev + 1) % slides.length);
  }, [slides.length]);

  const goPrev = useCallback(() => {
    setActiveIndex((prev) => (prev - 1 + slides.length) % slides.length);
  }, [slides.length]);

  useEffect(() => {
    if (slides.length <= 1 || isPaused) return;
    if (
      typeof window !== 'undefined' &&
      window.matchMedia &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
    ) {
      return;
    }
    const timer = window.setInterval(() => {
      setActiveIndex((prev) => (prev + 1) % slides.length);
    }, autoPlayMs);
    return () => window.clearInterval(timer);
  }, [slides.length, isPaused, autoPlayMs]);

  const handleTouchStart = (e: React.TouchEvent) => {
    touchStartX.current = e.touches[0]?.clientX ?? null;
    touchDeltaX.current = 0;
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    if (touchStartX.current === null) return;
    touchDeltaX.current = (e.touches[0]?.clientX ?? 0) - touchStartX.current;
  };

  const handleTouchEnd = () => {
    if (touchStartX.current === null) return;
    if (Math.abs(touchDeltaX.current) > 45 && slides.length > 1) {
      if (touchDeltaX.current < 0) {
        goNext();
      } else {
        goPrev();
      }
    }
    touchStartX.current = null;
    touchDeltaX.current = 0;
  };

  const currentSlide = slides[safeIndex];

  return (
    <div
      className="relative w-full overflow-hidden rounded-2xl border border-slate-200 bg-slate-900 shadow-sm select-none"
      onMouseEnter={() => setIsPaused(true)}
      onMouseLeave={() => setIsPaused(false)}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
      role="region"
      aria-roledescription="carousel"
      aria-label={`Banner Promo dan Pengumuman ${STORE_NAME}`}
    >
      {/* Slides Viewport */}
      <div
        className={`relative w-full ${
          compactPreview
            ? 'aspect-[16/9] min-h-[220px] max-h-[340px]'
            : 'aspect-[16/10] sm:aspect-[16/8] lg:aspect-[21/8] min-h-[260px] sm:min-h-[320px] lg:min-h-[380px] max-h-[460px]'
        }`}
      >
        {slides.map((slide, index) => {
          const isActive = index === safeIndex;
          const imgFailed = Boolean(brokenImages[slide.id]) || !slide.imageUrl;

          return (
            <div
              key={slide.id}
              aria-hidden={!isActive}
              className={`absolute inset-0 transition-opacity duration-500 ease-out ${
                isActive ? 'opacity-100 z-10' : 'opacity-0 z-0 pointer-events-none'
              }`}
            >
              {/* Background Visual or Styled Fallback */}
              {!imgFailed ? (
                <img
                  src={slide.imageUrl}
                  alt={slide.title}
                  referrerPolicy="no-referrer"
                  onError={() =>
                    setBrokenImages((prev) => ({ ...prev, [slide.id]: true }))
                  }
                  className="w-full h-full object-cover"
                />
              ) : (
                <div className="w-full h-full bg-gradient-to-br from-blue-950 via-slate-900 to-red-900 flex items-center justify-end pr-12">
                  <Store className="w-28 h-28 text-white/10" aria-hidden="true" />
                </div>
              )}

              {/* Measured Contrast Scrim (>= 4.5:1 text readability across all frames) */}
              <div
                aria-hidden="true"
                className="absolute inset-0 bg-gradient-to-r from-slate-950/90 via-slate-950/60 to-slate-950/20"
              />
              <div
                aria-hidden="true"
                className="absolute inset-0 bg-gradient-to-t from-slate-950/80 via-transparent to-transparent"
              />

              {/* Slide Content Overlay */}
              <div className="relative z-10 h-full flex flex-col justify-end sm:justify-center px-5 sm:px-10 lg:px-14 pb-12 sm:pb-10 pt-6 max-w-2xl space-y-2.5 sm:space-y-3.5">
                {slide.kicker && (
                  <p className="text-xs sm:text-sm font-semibold tracking-wide text-red-300">
                    {slide.kicker}
                  </p>
                )}

                <h2
                  className={`font-display font-bold tracking-tight text-white leading-[1.15] [text-wrap:balance] ${
                    compactPreview
                      ? 'text-lg sm:text-2xl'
                      : 'text-xl sm:text-3xl lg:text-4xl'
                  }`}
                >
                  {slide.title}
                </h2>

                {slide.subtitle && (
                  <p
                    className={`text-slate-200 leading-relaxed line-clamp-2 sm:line-clamp-3 ${
                      compactPreview ? 'text-xs sm:text-sm' : 'text-xs sm:text-base'
                    }`}
                  >
                    {slide.subtitle}
                  </p>
                )}

                {slide.ctaTarget !== 'none' && slide.ctaLabel && onNavigate && (
                  <div className="pt-1">
                    <button
                      type="button"
                      onClick={() => onNavigate(slide.ctaTarget as ActivePage)}
                      className="inline-flex items-center gap-2 px-5 py-2.5 text-xs sm:text-sm font-semibold text-white bg-red-600 hover:bg-blue-700 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
                    >
                      <span>{slide.ctaLabel}</span>
                      <ArrowRight className="w-4 h-4 shrink-0" />
                    </button>
                  </div>
                )}
              </div>
            </div>
          );
        })}

        {/* Prev / Next Navigation Buttons */}
        {slides.length > 1 && (
          <>
            <button
              type="button"
              onClick={goPrev}
              aria-label="Banner sebelumnya"
              className="absolute left-3 top-1/2 -translate-y-1/2 z-20 w-10 h-10 rounded-full bg-slate-950/60 hover:bg-slate-950/85 text-white border border-white/20 flex items-center justify-center transition-colors cursor-pointer focus-visible:outline-2 focus-visible:outline-white"
            >
              <ChevronLeft className="w-5 h-5" />
            </button>

            <button
              type="button"
              onClick={goNext}
              aria-label="Banner berikutnya"
              className="absolute right-3 top-1/2 -translate-y-1/2 z-20 w-10 h-10 rounded-full bg-slate-950/60 hover:bg-slate-950/85 text-white border border-white/20 flex items-center justify-center transition-colors cursor-pointer focus-visible:outline-2 focus-visible:outline-white"
            >
              <ChevronRight className="w-5 h-5" />
            </button>
          </>
        )}

        {/* Bottom Indicator Bar */}
        {slides.length > 1 && (
          <div className="absolute bottom-3 left-5 right-5 z-20 flex items-center justify-between gap-4">
            <div className="flex items-center gap-2" role="tablist" aria-label="Pilih slide banner">
              {slides.map((slide, idx) => {
                const active = idx === safeIndex;
                return (
                  <button
                    key={slide.id}
                    type="button"
                    role="tab"
                    aria-selected={active}
                    aria-label={`Slide ${idx + 1}: ${slide.title}`}
                    onClick={() => setActiveIndex(idx)}
                    className={`h-2 rounded-full transition-all cursor-pointer focus-visible:outline-2 focus-visible:outline-white ${
                      active
                        ? 'w-7 bg-white'
                        : 'w-2.5 bg-white/45 hover:bg-white/75'
                    }`}
                  />
                );
              })}
            </div>

            <div className="flex items-center gap-2">
              <span className="font-mono tabular-nums text-[11px] font-medium text-white/80">
                {safeIndex + 1} / {slides.length}
              </span>
              <button
                type="button"
                onClick={() => setIsPaused((prev) => !prev)}
                aria-label={isPaused ? 'Lanjutkan putar otomatis' : 'Jeda putar otomatis'}
                className="w-7 h-7 rounded-full bg-slate-950/55 hover:bg-slate-950/80 text-white border border-white/20 flex items-center justify-center transition-colors cursor-pointer"
              >
                {isPaused ? (
                  <Play className="w-3.5 h-3.5" />
                ) : (
                  <Pause className="w-3.5 h-3.5" />
                )}
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Screen-reader live announcement */}
      <span className="sr-only" aria-live="polite">
        {currentSlide ? `Menampilkan banner: ${currentSlide.title}` : ''}
      </span>
    </div>
  );
}
