/**
 * The Bonsai model catalogue — the in-browser options, and what they cost the visitor.
 *
 * DATA vendored from the platform's in-browser lane (`portal-kit/src/webml` /
 * `AitherVeil/src/lib/bonsai-models.ts`). Sizes are the REAL blob sizes from the
 * HuggingFace API (measured 2026-07-26), not estimates:
 *
 *      1.7B  236 MB      4B  545 MB      8B  1104 MB      27B  3627 MB
 *
 * WHY FOUR SIZES. The lane once hardcoded ONE url — Bonsai-27B-Q1_0, 3627 MB — and
 * handed it to every visitor regardless of device. A phone got the 27B: a
 * multi-minute download followed by an unusably slow model. Give people options,
 * default to what works on their device, let the big brain be a deliberate opt-in.
 *
 * WHY Q1_0 ONLY. The upstream family also ships ternary Bonsai (Q2_0, the
 * higher-quality option). The WebGPU kernels implement Q1_0 only — Q2_0 needs new
 * dequant + matmul kernels, which is real work, not a config flag. The `quant`
 * field is honest metadata: the brick does not pretend a quant it cannot decode
 * is available.
 *
 * This module is self-contained (vendored data + pure functions) so it can be
 * imported by any consumer — the browser, a Node audit script, a build step —
 * without touching the runtime.
 */

import { classifyAdapter, isMobileDevice } from './is-supported.js';

export interface BonsaiModel {
  id: string;
  /** Shown in the picker. */
  label: string;
  params: string;
  /** Real download size, from the HF blob API. */
  sizeMb: number;
  /** Upstream GGUF url (the mirror, not this, is what browsers download — see resolveBonsaiUrl). */
  url: string;
  /** The quantisation the shipped GGUF actually uses. Q2_0/ternary is NOT supported by the kernels. */
  quant: string;
  /** Model's trained context. The runtime may use less; see pickContext(). */
  contextWindow: number;
  /** Plain-language guidance — what this size is actually for. */
  blurb: string;
  /**
   * GGUF `general.architecture`, read from each file's real KV metadata.
   * 'qwen35' is the DeltaNet + gated-full-attention hybrid (27B only); 'qwen3'
   * is stock dense attention. Both run in-browser. DESCRIPTIVE, not a switch:
   * the runtime derives each layer's kind from the tensor shapes it loaded.
   */
  arch: 'qwen3' | 'qwen35';
}

const HF = 'https://huggingface.co/prism-ml';

const DEFAULT_MIRROR_BASE = 'https://weights.aitherium.com';

/**
 * The self-hosted weight mirror — a Cloudflare Worker over the aitherkvcache
 * release assets, serving the SAME filenames with Range + CORS.
 *
 * Why the mirror, not the upstream, is what browsers download: the upstream HF
 * repo has been gated once already (anonymous browsers got 401 and sat at
 * "Brain loading…" forever — a stall, not an error). Measured 2026-08-02, all
 * four models serve 206 + `Access-Control-Allow-Origin` from the mirror with
 * byte counts identical to the primary.
 *
 * Override point: `setMirrorBase()` / `configureAwbonsai({ mirrorBase })`.
 * Pass `null`, `''` or `'none'` to genuinely disable the mirror — do not leave
 * it unset if you want it off; unset means DEFAULT (measured working).
 */
let mirrorBase = DEFAULT_MIRROR_BASE;

export function setMirrorBase(base: string | null | undefined): void {
  if (base === undefined) { mirrorBase = DEFAULT_MIRROR_BASE; return; }
  if (base === null || base === '' || base === 'none') { mirrorBase = ''; return; }
  mirrorBase = base.replace(/\/+$/, '');
}

export function getMirrorBase(): string {
  return mirrorBase;
}

export const BONSAI_MODELS: BonsaiModel[] = [
  {
    id: 'bonsai-1.7b',
    label: 'Bonsai 1.7B',
    params: '1.7B',
    sizeMb: 236,
    url: `${HF}/Bonsai-1.7B-gguf/resolve/main/Bonsai-1.7B-Q1_0.gguf`,
    quant: 'Q1_0',
    contextWindow: 32768,
    blurb: 'The lightest size — 236 MB, runs right here in your browser, and quick enough on a phone. Start here.',
    arch: 'qwen3',
  },
  {
    id: 'bonsai-4b',
    label: 'Bonsai 4B',
    params: '4B',
    sizeMb: 545,
    url: `${HF}/Bonsai-4B-gguf/resolve/main/Bonsai-4B-Q1_0.gguf`,
    quant: 'Q1_0',
    contextWindow: 32768,
    blurb: 'The balanced pick: noticeably smarter than 1.7B, still a quick download, still runs in the browser.',
    arch: 'qwen3',
  },
  {
    id: 'bonsai-8b',
    label: 'Bonsai 8B',
    params: '8B',
    sizeMb: 1104,
    url: `${HF}/Bonsai-8B-gguf/resolve/main/Bonsai-8B-Q1_0.gguf`,
    quant: 'Q1_0',
    contextWindow: 65536,
    blurb: 'Better reasoning, ~1 GB. Comfortable on a desktop with a real GPU; a big ask on a phone.',
    arch: 'qwen3',
  },
  {
    id: 'bonsai-27b-text',
    label: 'Bonsai 27B',
    params: '27B',
    sizeMb: 3627,
    url: `${HF}/Bonsai-27B-gguf/resolve/main/Bonsai-27B-Q1_0.gguf`,
    quant: 'Q1_0',
    contextWindow: 262144,
    blurb: 'The full brain. 3.6 GB and slow in a browser — for a real GPU, or self-host it with llama.cpp for the higher-quality ternary build.',
    arch: 'qwen35',
  },
];

/**
 * The sizes the IN-BROWSER runtime can actually load. ALL FOUR since 2026-07-28.
 * A filter over a PROPERTY rather than an id list, so a future Bonsai on a third
 * architecture stays out by default instead of silently inheriting "runnable".
 */
const BROWSER_ARCHES: ReadonlyArray<BonsaiModel['arch']> = ['qwen3', 'qwen35'];

export function browserRunnableModels(): BonsaiModel[] {
  return BONSAI_MODELS.filter((m) => BROWSER_ARCHES.includes(m.arch));
}

/**
 * The FAST in-browser default. 4B was the old default and on a GPU shared with a
 * fleet it decodes ~10-15 tok/s; 1.7B loads in half the time and decodes ~2.3x
 * faster. Errs small on purpose: the picker upgrades to 4B/8B/27B on demand.
 */
export const DEFAULT_MODEL_ID = 'bonsai-1.7b';

export function getBonsaiModel(id: string): BonsaiModel | undefined {
  return BONSAI_MODELS.find((m) => m.id === id);
}

/**
 * The ordered list of URLs to try for a model: primary first, mirror second.
 * The mirror keeps the FILENAME, so it is a flat bucket of `Bonsai-4B-Q1_0.gguf`
 * — anything that can serve a file by name with range + CORS can be a mirror.
 */
export function mirrorUrls(m: Pick<BonsaiModel, 'url'>): string[] {
  const urls = [m.url];
  if (mirrorBase) {
    const file = m.url.split('/').pop();
    if (file) urls.push(`${mirrorBase}/${file}`);
  }
  return urls;
}

/**
 * The URL a browser should download this model from: the self-hosted mirror
 * when configured (it is by default), else the upstream primary. This is what
 * a consumer hosts in their own worker script, or what the loader passes to an
 * engine that accepts an explicit URL.
 */
export function resolveBonsaiUrl(id: string): string {
  const m = getBonsaiModel(id) ?? getBonsaiModel(DEFAULT_MODEL_ID)!;
  const urls = mirrorUrls(m);
  return urls.length > 1 ? urls[urls.length - 1] : urls[0];
}

/** What we know about the GPU that will actually run this — `GPUAdapterInfo`. */
export interface GpuHint {
  /** `GPUAdapterInfo.vendor` — "intel", "nvidia", "amd", "apple", "qualcomm", "microsoft"… */
  vendor?: string;
  /** `GPUAdapterInfo.architecture` — "gen-12lp", "ada-lovelace", "apple-m1"… */
  architecture?: string;
  /** The adapter is a software rasteriser (SwiftShader/WARP) — running on the CPU. */
  isFallbackAdapter?: boolean;
}

/**
 * The download ceiling this GPU should be trusted with, in MB. `Infinity` = "no opinion".
 *
 * VENDOR IS A WEAK SIGNAL AND IS TREATED AS ONE: it can only step the suggestion
 * DOWN — never promote — because a wrong guess in the heavy direction costs a
 * multi-minute download that ends in an unusable tab, and a wrong guess in the
 * light direction costs one deliberate click on a picker.
 *
 * The integrated ceiling is the 1.7B because the 4B once BROKE a machine: a Yoga
 * 7i (Iris Xe) streamed the 4B, then the turn died and the laptop's display
 * driver entered a TDR reset loop that outlived the tab (incident 2026-07-31).
 *
 * On MOBILE an absent hint must NOT return Infinity: `GPUAdapterInfo` is Chrome
 * 128+ and Safari exposes nothing, so a phone always lands here — and returning
 * Infinity would clear every size in the catalogue for the device that can least
 * afford it. The refusal lives where the NULL is handled.
 */
export function gpuSizeCeilingMb(gpu?: GpuHint): number {
  const sizeOf = (id: string) => getBonsaiModel(id)!.sizeMb;
  switch (classifyAdapter(gpu)) {
    case 'software':
    case 'integrated':
      return sizeOf('bonsai-1.7b');
    default:
      return isMobileDevice() ? sizeOf('bonsai-1.7b') : Infinity;
  }
}

/** Step a suggestion DOWN to the largest catalog entry within `ceilingMb`. Never up. */
function clampToGpu(id: string, gpu?: GpuHint): string {
  const ceiling = gpuSizeCeilingMb(gpu);
  if (ceiling === Infinity) return id;
  const picked = getBonsaiModel(id);
  if (!picked || picked.sizeMb <= ceiling) return id;
  const lighter = browserRunnableModels()
    .filter((m) => m.sizeMb <= ceiling)
    .sort((a, b) => b.sizeMb - a.sizeMb)[0];
  return lighter?.id ?? id;
}

/**
 * Suggest a size for THIS device. A suggestion only — the picker always wins.
 * Errs small: an underpowered pick is a fast disappointment, an overpowered one
 * is a ten-minute download that ends in a hung tab.
 */
export function suggestModelId(gpu?: GpuHint): string {
  if (typeof navigator === 'undefined') return DEFAULT_MODEL_ID;
  const nav = navigator as Navigator & {
    deviceMemory?: number;
    connection?: { saveData?: boolean; effectiveType?: string };
  };
  if (nav.connection?.saveData) return 'bonsai-1.7b';
  const slowLink = nav.connection?.effectiveType && /2g/.test(nav.connection.effectiveType);
  if (slowLink) return 'bonsai-1.7b';

  const mem = nav.deviceMemory ?? 4;
  const mobile = isMobileDevice();
  const byRam = mobile
    ? (mem >= 6 ? 'bonsai-4b' : 'bonsai-1.7b')
    : DEFAULT_MODEL_ID;
  return clampToGpu(byRam, gpu);
}

/** One short line naming the GPU actually in use, for a picker. Empty when the browser exposes no info. */
export function describeAdapter(gpu?: GpuHint): string {
  const parts = [gpu?.vendor, gpu?.architecture].map((s) => s?.trim()).filter(Boolean);
  if (gpu?.isFallbackAdapter) {
    return parts.length ? `${parts.join(' · ')} (cpu)` : 'cpu (no gpu found)';
  }
  return parts.join(' · ');
}

/**
 * Context to actually allocate, RAM-tiered. The 27B advertises 262k, but
 * allocating a KV cache for the full trained context on a modest machine is how
 * you freeze a tab. Never exceed the model's own window.
 */
export function pickContext(model: BonsaiModel): number {
  const mem = (typeof navigator !== 'undefined'
    && (navigator as Navigator & { deviceMemory?: number }).deviceMemory) || 4;
  const tier = mem >= 16 ? 32768 : mem >= 8 ? 16384 : mem >= 4 ? 8192 : 4096;
  return Math.min(tier, model.contextWindow);
}
