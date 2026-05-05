"use client";

import Lenis from "lenis";
import { motion, useMotionValue, useTransform } from "framer-motion";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

const BG = "#0d0804";

/** Exact filenames: public/sequence/ezgif-frame-001.png … ezgif-frame-120.png */
function frameUrl(index: number): string {
  return `/sequence/ezgif-frame-${String(index).padStart(3, "0")}.png`;
}

const TOTAL_FRAMES = 120;

/**
 * More viewport-height = more pixels per frame (120 PNGs read as a film, not a slideshow).
 * Lower (e.g. 520) if you want a quicker pass.
 */
const SCROLL_TRACK_VH = 720;

/** Visual progress eases toward real scroll (frame-rate independent). Higher = tighter follow. */
const SMOOTH_LAMBDA_BASE = 7.5;
const SMOOTH_LAMBDA_BOOST = 78;

function loadFrame(index: number): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = "async";
    img.onload = () => resolve(img);
    img.onerror = () =>
      reject(new Error(`Failed to load ${frameUrl(index)}`));
    img.src = frameUrl(index);
  });
}

/**
 * Loads all TOTAL_FRAMES in parallel, sorts by numeric index (001…120),
 * decodes every image, then returns — animation stays hidden until complete.
 */
async function loadAllFrames(): Promise<HTMLImageElement[]> {
  const indexed = await Promise.all(
    Array.from({ length: TOTAL_FRAMES }, (_, i) => {
      const index = i + 1;
      return loadFrame(index).then((img) => ({ index, img }));
    }),
  );
  indexed.sort((a, b) => a.index - b.index);
  const imgs = indexed.map((e) => e.img);
  await Promise.all(imgs.map((img) => img.decode().catch(() => undefined)));
  return imgs;
}

type Layout = { wCss: number; hCss: number; wPx: number; hPx: number; dpr: number };

/**
 * 0 = section top aligned with viewport top, 1 = scrolled through full track.
 * Same math as Framer "start start" → "end end" for a tall block (no extra spring lag).
 */
function computeScrollProgress(scrollRoot: HTMLElement): number {
  const range = scrollRoot.offsetHeight - window.innerHeight;
  if (range <= 1) return 0;
  const top = scrollRoot.getBoundingClientRect().top;
  const p = -top / range;
  return Math.min(1, Math.max(0, p));
}

/** Ease crossfade alpha so blends feel less “fluttery” between near-identical frames. */
function smoothstep01(x: number): number {
  const t = Math.min(1, Math.max(0, x));
  return t * t * (3 - 2 * t);
}

/** Exponential ease toward target; dt in seconds. Used for “liquid” scroll-linked motion. */
function dampToward(current: number, target: number, lambda: number, dt: number): number {
  const t = Math.min(0.1, Math.max(0, dt));
  return current + (target - current) * (1 - Math.exp(-lambda * t));
}

export function JewelScroll() {
  const scrollRootRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const framesRef = useRef<HTMLImageElement[]>([]);
  const layoutRef = useRef<Layout>({
    wCss: 0,
    hCss: 0,
    wPx: 0,
    hPx: 0,
    dpr: 1,
  });
  const drawRef = useRef<() => void>(() => {});

  /**
   * Drives overlays + canvas. We ease this toward the “raw” scroll progress each RAF so
   * frame crossfades and copy feel continuous (smooth scroll), not stepped to layout ticks.
   */
  const scrollProgress = useMotionValue(0);
  const visualProgressRef = useRef(0);
  const smoothTimeRef = useRef<number | null>(null);

  const [frames, setFrames] = useState<HTMLImageElement[]>([]);
  const [loadState, setLoadState] = useState<"loading" | "ready" | "error">(
    "loading",
  );
  const [loadError, setLoadError] = useState<string | null>(null);

  const heroOpacity = useTransform(scrollProgress, [0, 0.14], [1, 0]);
  const yearsOpacity = useTransform(
    scrollProgress,
    [0.18, 0.26, 0.34, 0.44],
    [0, 1, 1, 0],
  );
  const stonesOpacity = useTransform(
    scrollProgress,
    [0.5, 0.58, 0.64, 0.74],
    [0, 1, 1, 0],
  );
  const ctaOpacity = useTransform(scrollProgress, [0.8, 0.88, 1], [0, 1, 1]);

  useEffect(() => {
    let alive = true;
    loadAllFrames()
      .then((imgs) => {
        if (!alive) return;
        framesRef.current = imgs;
        setFrames(imgs);
        setLoadState("ready");
      })
      .catch(() => {
        if (!alive) return;
        setLoadState("error");
        setLoadError("Could not load image sequence.");
      });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    framesRef.current = frames;
  }, [frames]);

  const ensureCanvasPhysicalSize = useCallback((canvas: HTMLCanvasElement) => {
    const dpr = Math.min(typeof window !== "undefined" ? window.devicePixelRatio : 1, 2);
    const rect = canvas.getBoundingClientRect();
    const wCss = rect.width;
    const hCss = rect.height;
    if (wCss < 1 || hCss < 1) return false;

    const wPx = Math.max(1, Math.round(wCss * dpr));
    const hPx = Math.max(1, Math.round(hCss * dpr));
    const L = layoutRef.current;

    if (L.wPx !== wPx || L.hPx !== hPx || L.dpr !== dpr) {
      canvas.width = wPx;
      canvas.height = hPx;
      L.wPx = wPx;
      L.hPx = hPx;
      L.dpr = dpr;
    }
    L.wCss = wCss;
    L.hCss = hCss;
    return true;
  }, []);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const list = framesRef.current;
    if (!canvas || list.length === 0) return;

    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) return;
    if (!ensureCanvasPhysicalSize(canvas)) return;

    const { wCss, hCss, dpr } = layoutRef.current;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, wCss, hCss);

    const p = scrollProgress.get();
    const maxIdx = list.length - 1;
    const floatIndex = Math.min(maxIdx, Math.max(0, p * maxIdx));
    const i0 = Math.floor(floatIndex);
    const i1 = Math.min(maxIdx, i0 + 1);
    const t = floatIndex - i0;

    const img0 = list[i0];
    const img1 = list[i1];
    const iw = img0.naturalWidth || img0.width;
    const ih = img0.naturalHeight || img0.height;
    if (!iw || !ih) return;

    const scale = Math.min(wCss / iw, hCss / ih);
    const dw = iw * scale;
    const dh = ih * scale;
    const dx = (wCss - dw) / 2;
    const dy = (hCss - dh) / 2;

    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";

    // Fill background with gradient to cover gaps
    const gradient = ctx.createLinearGradient(0, 0, 0, hCss);
    gradient.addColorStop(0, "#1a1208");
    gradient.addColorStop(0.5, "#0d0804");
    gradient.addColorStop(1, "#0a0602");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, wCss, hCss);

    ctx.globalAlpha = 1;
    ctx.drawImage(img0, dx, dy, dw, dh);
    if (t > 0.002 && img1 !== img0) {
      ctx.globalAlpha = smoothstep01(t);
      ctx.drawImage(img1, dx, dy, dw, dh);
    }
    ctx.globalAlpha = 1;
  }, [scrollProgress, ensureCanvasPhysicalSize]);

  useLayoutEffect(() => {
    drawRef.current = draw;
  }, [draw]);

  useEffect(() => {
    if (loadState !== "ready" || frames.length === 0) return;

    const reduceMotion =
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    let rafId = 0;
    let primed = false;

    const tick = (now: number) => {
      const root = scrollRootRef.current;
      const raw = root ? computeScrollProgress(root) : 0;

      if (!primed) {
        visualProgressRef.current = raw;
        primed = true;
      }

      let p: number;
      if (reduceMotion) {
        p = raw;
        visualProgressRef.current = raw;
      } else {
        const prevT = smoothTimeRef.current ?? now;
        const dt = Math.min(0.064, Math.max(0, (now - prevT) / 1000));
        smoothTimeRef.current = now;

        const v = visualProgressRef.current;
        const err = raw - v;
        const lambda =
          SMOOTH_LAMBDA_BASE + Math.min(28, Math.abs(err) * SMOOTH_LAMBDA_BOOST);
        visualProgressRef.current = dampToward(v, raw, lambda, dt);
        p = visualProgressRef.current;
      }

      scrollProgress.set(p);
      drawRef.current();
      rafId = requestAnimationFrame(tick);
    };

    rafId = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(rafId);
      smoothTimeRef.current = null;
    };
  }, [loadState, frames.length, scrollProgress]);

  useEffect(() => {
    if (loadState !== "ready") return;
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ro = new ResizeObserver(() => {
      drawRef.current();
    });
    ro.observe(canvas);

    const onResize = () => drawRef.current();
    window.addEventListener("orientationchange", onResize);

    return () => {
      ro.disconnect();
      window.removeEventListener("orientationchange", onResize);
    };
  }, [loadState]);

  useEffect(() => {
    const reduceMotion =
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    if (reduceMotion) return;

    /** Lenis = smooth wheel/touch inertia; damping above = smooth frame strip + UI. */
    const lenis = new Lenis({
      autoRaf: true,
      lerp: 0.075,
      wheelMultiplier: 0.94,
      touchMultiplier: 0.9,
      syncTouch: true,
      syncTouchLerp: 0.075,
      smoothWheel: true,
      overscroll: false,
    });

    return () => {
      lenis.destroy();
    };
  }, []);

  const retry = () => {
    setLoadState("loading");
    setLoadError(null);
    loadAllFrames()
      .then((imgs) => {
        framesRef.current = imgs;
        setFrames(imgs);
        setLoadState("ready");
      })
      .catch(() => {
        setLoadState("error");
        setLoadError("Could not load image sequence.");
      });
  };

  return (
    <>
      {loadState === "loading" && (
        <motion.div
          className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-6 bg-[#0d0804]"
          initial={{ opacity: 1 }}
          animate={{ opacity: 1 }}
        >
          <motion.span
            className="h-2.5 w-2.5 rounded-full bg-[#c9a84c]"
            aria-hidden
            animate={{
              scale: [1, 1.45, 1],
              opacity: [0.45, 1, 0.45],
              boxShadow: [
                "0 0 0 0 rgba(201,168,76,0.35)",
                "0 0 24px 4px rgba(201,168,76,0.45)",
                "0 0 0 0 rgba(201,168,76,0.35)",
              ],
            }}
            transition={{
              duration: 1.25,
              repeat: Infinity,
              ease: "easeInOut",
            }}
          />
          <p className="text-sm tracking-tight text-white/50">
            Preparing craftsmanship…
          </p>
        </motion.div>
      )}

      {loadState === "error" && (
        <div className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-4 bg-[#0d0804] px-6 text-center">
          <p className="max-w-md text-white/70 tracking-tight">
            {loadError ?? "Something went wrong."}
          </p>
          <button
            type="button"
            onClick={retry}
            className="rounded-full border border-[#c9a84c]/50 bg-[#c9a84c]/10 px-6 py-2.5 text-sm font-medium tracking-tight text-[#c9a84c] transition hover:bg-[#c9a84c]/20"
          >
            Try again
          </button>
        </div>
      )}

      <div
        ref={scrollRootRef}
        className="relative isolate w-full touch-pan-y"
        style={{
          touchAction: "pan-y",
          height: `${SCROLL_TRACK_VH}vh`,
        }}
      >
        <div className="sticky top-0 h-[100dvh] min-h-screen w-full overflow-hidden bg-[#0d0804]">
          <canvas
            ref={canvasRef}
            className="absolute inset-0 block h-full w-full"
            aria-hidden
          />

          <div className="pointer-events-none absolute inset-0 z-10 flex flex-col">
            <motion.div
              style={{ opacity: heroOpacity }}
              className="flex flex-1 flex-col items-center justify-center px-6 text-center"
            >
              <h1 className="jewel-heading-glow text-4xl font-light tracking-[-0.04em] text-white/90 sm:text-6xl md:text-7xl">
                Kalyan Jewellers.
              </h1>
              <p className="mt-4 jewel-gold-glow text-lg font-light tracking-[-0.02em] text-[#c9a84c] sm:text-xl">
                Worn by Generations.
              </p>
            </motion.div>

            <motion.div
              style={{ opacity: yearsOpacity }}
              className="absolute left-0 top-[28%] max-w-[min(90vw,28rem)] px-6 sm:left-10 sm:px-0"
            >
              <h2 className="jewel-heading-glow text-2xl font-light tracking-[-0.03em] text-white/90 sm:text-4xl">
                112 Years of Trust.
              </h2>
              <p className="mt-2 text-sm leading-relaxed text-white/60 sm:text-base">
                A legacy measured in lifetimes, not seasons.
              </p>
            </motion.div>

            <motion.div
              style={{ opacity: stonesOpacity }}
              className="absolute right-0 top-[52%] max-w-[min(90vw,26rem)] px-6 text-right sm:right-10 sm:px-0"
            >
              <h2 className="jewel-heading-glow text-2xl font-light tracking-[-0.03em] text-white/90 sm:text-4xl">
                Every Stone. Every Link. Intentional.
              </h2>
              <p className="mt-2 text-sm leading-relaxed text-white/60 sm:text-base">
                Kundan artistry, revealed in motion.
              </p>
            </motion.div>

            <motion.div
              style={{ opacity: ctaOpacity }}
              className="absolute inset-x-0 bottom-[12%] flex flex-col items-center gap-6 px-6 text-center sm:bottom-[14%]"
            >
              <h2 className="jewel-heading-glow text-3xl font-light tracking-[-0.04em] text-white/90 sm:text-5xl md:text-6xl">
                Find Yours.
              </h2>
              <a
                href="https://www.kalyanjewellers.net/"
                target="_blank"
                rel="noopener noreferrer"
                className="pointer-events-auto inline-flex items-center justify-center rounded-full bg-[#c9a84c] px-8 py-3.5 text-sm font-medium tracking-tight text-[#0d0804] shadow-[0_0_40px_rgba(201,168,76,0.25)] transition hover:bg-[#d4b45d] hover:shadow-[0_0_48px_rgba(201,168,76,0.35)]"
              >
                Explore Collection
              </a>
            </motion.div>
          </div>
        </div>
      </div>
    </>
  );
}
