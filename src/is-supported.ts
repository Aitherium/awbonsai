/**
 * Honest capability detection — the BIH003 / BCG rule set, packaged for strangers.
 *
 * The rules vendored here come from the platform's in-browser lane
 * (`portal-kit/src/webml/bonsai/gpu-class.ts` and `AitherVeil/src/lib/bonsai-consent.ts`)
 * and are the hard-won ones:
 *
 * 1. A NULL adapter hint must never read as "allowed". `GPUAdapterInfo` is Chrome
 *    128+ and Safari exposes nothing at all, so on an iPhone `requestAdapter()`
 *    either returns null or an adapter with no info — and a guard keyed on the
 *    hint would be skipped on exactly the devices that need it most. The refusal
 *    lives where the NULL is handled (BIH003).
 * 2. MOBILE IS REFUSED OUTRIGHT, tap or no tap. A mobile browser reclaims a
 *    background tab's memory and kills the worker holding the weights; nothing is
 *    posted when that happens (BIH001), so the tab crashes with no error. The GPU
 *    lane does not run on phones; the WASM CPU lane is the mobile path.
 * 3. A SOFTWARE rasteriser (SwiftShader/WARP) is not a GPU. It reports a routinely
 *    EMPTY vendor string, so it must be checked FIRST — an empty vendor would
 *    otherwise classify as `unknown` and take the fast path (measured: the same
 *    model at 0.33 tok/s on the fallback vs 41 tok/s on a real GPU).
 * 4. iPadOS 13+ sends a DESKTOP Safari UA containing "Macintosh". The touch
 *    check catches it; a plain UA regex misses every modern iPad (BIH004).
 * 5. `isSupported()` downloads NOTHING and asks for NO consent — it is a pure
 *    probe. The moment anything downloads is the moment the consent gate runs.
 */

export type GpuClass = 'software' | 'integrated' | 'discrete' | 'unknown';

/**
 * `GPUAdapterInfo` — Chrome 128+ populates a coarse vendor/architecture pair.
 * Safari and Firefox expose nothing at all, which is why `adapter` can be null
 * even on a machine with a perfectly good GPU.
 */
export interface AdapterHint {
  vendor?: string;
  architecture?: string;
  /**
   * The adapter is a SOFTWARE rasteriser the browser substituted for a real GPU.
   * Decisive and checked FIRST: a fallback adapter routinely reports NO vendor,
   * and an empty vendor would classify as `unknown` — the fast path.
   */
  isFallbackAdapter?: boolean;
}

/**
 * Vendors that ship ONLY integrated parts in a browser context.
 * `apple` is absent deliberately (Apple Silicon is integrated but fast); `amd`
 * is absent because the vendor string cannot separate a Radeon from an APU.
 */
const INTEGRATED_VENDORS = ['intel', 'arm', 'qualcomm', 'imgtec'] as const;

/** `microsoft` is WARP, Chrome's software rasteriser fallback. */
const SOFTWARE_VENDORS = ['microsoft'] as const;

export function classifyAdapter(hint?: AdapterHint | null): GpuClass {
  if (hint?.isFallbackAdapter === true) return 'software';
  const vendor = hint?.vendor?.trim().toLowerCase();
  if (!vendor) return 'unknown';
  if ((SOFTWARE_VENDORS as readonly string[]).includes(vendor)) return 'software';
  if ((INTEGRATED_VENDORS as readonly string[]).includes(vendor)) return 'integrated';
  return 'unknown';
}

/**
 * Is this a phone or tablet? Pure, so the tests can drive it without a DOM.
 *
 * The `Macintosh` + touch branch is the half everyone omits: iPadOS 13+ sends a
 * DESKTOP Safari user agent, so a plain UA regex misses every modern iPad.
 */
export function isMobileDevice(userAgent?: string, maxTouchPoints?: number): boolean {
  const ua = userAgent
    ?? (typeof navigator !== 'undefined' ? navigator.userAgent : '');
  if (/Android|iPhone|iPad|iPod|Mobile|Silk|Kindle/i.test(ua)) return true;
  const touch = maxTouchPoints
    ?? (typeof navigator !== 'undefined'
      ? (navigator as { maxTouchPoints?: number }).maxTouchPoints ?? 0
      : 0);
  return /Macintosh/i.test(ua) && touch > 1;
}

/** May the WebGPU lane run on this device AT ALL? Phones: never (see header). */
export function gpuLaneAllowed(userAgent?: string, maxTouchPoints?: number): boolean {
  return !isMobileDevice(userAgent, maxTouchPoints);
}

/**
 * May a model start WITHOUT an explicit tap this visit?
 *
 * Null-safe on purpose: an absent adapter hint must not short-circuit to
 * "allowed". On mobile it is a refusal; everywhere else an absent hint means
 * "no opinion" and defers to the class (a software-rasteriser refusal genuinely
 * cannot be made without a hint).
 */
export function autoBootAllowed(hint?: AdapterHint | null, userAgent?: string, maxTouchPoints?: number): boolean {
  if (isMobileDevice(userAgent, maxTouchPoints)) return false;
  if (!hint) return true;
  return classifyAdapter(hint) !== 'software';
}

/** Everything `assessSupport` needs to know about the environment. Pure. */
export interface SupportEnv {
  hasNavigator: boolean;
  userAgent: string;
  maxTouchPoints: number;
  /** `'gpu' in navigator` — the WebGPU API exists. */
  hasWebGpu: boolean;
  /** `'ml' in navigator` — the WebNN API exists. */
  hasWebNn: boolean;
  /**
   * Result of `requestAdapter()`, or null when there is no adapter at all.
   * A software fallback (found by re-probing with `forceFallbackAdapter`) is
   * recorded as `isFallbackAdapter: true` — which is what makes an empty-vendor
   * fallback classify as `software` instead of `unknown`.
   */
  adapter: AdapterHint | null;
  /** `requestAdapter()` threw — a probe failure is not "no adapter", it is a verdict of its own. */
  adapterError?: string | null;
}

export interface SupportReport {
  /** A model can plausibly run in the WebGPU lane here. `reason` explains a `false`. */
  supported: boolean;
  /** The WebGPU API is exposed by the browser (does NOT mean an adapter exists). */
  webgpu: boolean;
  /** The WebNN API is exposed by the browser. */
  webnn: boolean;
  gpuClass: GpuClass;
  mobile: boolean;
  adapter: AdapterHint | null;
  /** Why `supported` is false, or null when it is supported. Never empty prose. */
  reason: string | null;
}

/**
 * The decision, pure. `isSupported()` gathers the environment and calls this, so
 * the null-adapter / iPadOS / software-rasteriser cases are testable in Node.
 */
export function assessSupport(env: SupportEnv): SupportReport {
  const base = {
    webgpu: env.hasWebGpu,
    webnn: env.hasWebNn,
    gpuClass: classifyAdapter(env.adapter),
    mobile: isMobileDevice(env.userAgent, env.maxTouchPoints),
    adapter: env.adapter,
  };
  if (!env.hasNavigator) {
    return { ...base, supported: false, reason: 'not a browser environment — awbonsai runs in a tab' };
  }
  // The GPU lane is refused OUTRIGHT on mobile, tap or no tap: the OS kills the
  // worker holding the weights, and a killed worker posts nothing (BIH001).
  if (base.mobile) {
    return { ...base, supported: false, reason: 'mobile: the WebGPU lane is refused — a mobile browser reclaims the worker\'s memory; the WASM CPU lane is the mobile path' };
  }
  if (!env.hasWebGpu) {
    return { ...base, supported: false, reason: 'WebGPU is not available in this browser (Chrome/Edge 113+, Firefox 141+, Safari 26+ expose it)' };
  }
  if (env.adapterError) {
    return { ...base, supported: false, reason: `WebGPU adapter probe failed: ${env.adapterError}` };
  }
  if (!env.adapter) {
    return { ...base, supported: false, reason: 'no WebGPU adapter — requestAdapter() returned null (no usable GPU on this machine)' };
  }
  if (base.gpuClass === 'software') {
    return { ...base, supported: false, reason: 'software rasteriser only (no real GPU) — a model here runs at ~0.1 tok/s; not usable' };
  }
  return { ...base, supported: true, reason: null };
}

interface GpuAdapterLike {
  info?: { vendor?: string; architecture?: string };
}
interface GpuLike {
  requestAdapter?: (opts?: { forceFallbackAdapter?: boolean }) => Promise<GpuAdapterLike | null>;
}

/**
 * Probe the real environment. Downloads nothing, asks no consent — a pure read.
 * On `requestAdapter()` returning null it re-probes with `forceFallbackAdapter`:
 * if ONLY a fallback exists, there is no real GPU, and that must be reported as
 * `isFallbackAdapter` rather than as a null that reads "no opinion".
 */
export async function isSupported(): Promise<SupportReport> {
  if (typeof navigator === 'undefined') {
    return assessSupport({
      hasNavigator: false, userAgent: '', maxTouchPoints: 0,
      hasWebGpu: false, hasWebNn: false, adapter: null,
    });
  }
  const nav = navigator as unknown as {
    userAgent: string;
    maxTouchPoints?: number;
    gpu?: GpuLike;
    ml?: unknown;
  };
  let adapter: AdapterHint | null = null;
  let adapterError: string | null = null;
  if (nav.gpu?.requestAdapter) {
    try {
      const a = await nav.gpu.requestAdapter();
      if (a) {
        adapter = { vendor: a.info?.vendor, architecture: a.info?.architecture };
      } else {
        // No real adapter. Is there at least a software fallback? Its existence
        // is the honest answer to "is there a GPU at all" — as a fallback.
        try {
          const fb = await nav.gpu.requestAdapter({ forceFallbackAdapter: true });
          if (fb) {
            adapter = {
              isFallbackAdapter: true,
              vendor: fb.info?.vendor,
              architecture: fb.info?.architecture,
            };
          }
        } catch {
          /* probe failure for the fallback — stay null, which is itself a refusal */
        }
      }
    } catch (e) {
      adapterError = String(e);
    }
  }
  return assessSupport({
    hasNavigator: true,
    userAgent: nav.userAgent,
    maxTouchPoints: nav.maxTouchPoints ?? 0,
    hasWebGpu: !!nav.gpu,
    hasWebNn: !!nav.ml,
    adapter,
    adapterError,
  });
}
