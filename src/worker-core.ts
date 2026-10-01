/**
 * The worker contract and a thin typed bridge over it.
 *
 * The wire protocol here is the REAL one used by the platform's in-browser lane
 * (`portal-kit/src/webml/bonsai/worker/bonsai-worker-core.ts`): the same
 * `load|generate|interrupt` request set and the same
 * `progress|ready|token|tool_action|image|done|error` response set. A worker
 * script that speaks this protocol — the engine, which is NOT vendored here and
 * is loaded from the mirror at runtime — can be driven by this bridge.
 *
 * What this file deliberately does NOT do:
 *  - it does not vendor llama.cpp, the WGSL kernels, the tokenizer or the GGUF
 *    decoder — the ENGINE is the separately-built worker script this bridge
 *    talks to, loaded at runtime (see `setWorkerScriptUrl`);
 *  - it does not extend the wire format. `{type:"load"}` carries exactly
 *    `modelId`; a host that wants its own URL resolution hosts its own engine
 *    script and points the brick at it.
 *
 * The bridge is host-side: it adapts a Worker (or anything Worker-like — which
 * is how the tests drive it) into promises + streaming callbacks, and it
 * honours the one rule the wire contract carries: a `fatal` error — the
 * `device-lost` class — is LATCHED and never retried automatically, because
 * retrying re-arms the driver reset that caused it.
 */

import { DeviceLostError, GenerationAbortedError, WorkerIntegrityError } from './errors.js';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /** For assistant messages: tool calls made in this turn (optional, for replay). */
  tool_calls?: Array<{ function: { name: string; arguments: unknown } }>;
}

export interface ToolFunction {
  name: string;
  description: string;
  parameters: {
    type: string;
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export type WorkerRequest =
  | { type: 'load'; modelId: string }
  | {
      type: 'generate';
      messages: ChatMessage[];
      maxTokens?: number;
      temperature?: number;
      topK?: number;
      topP?: number;
      repetitionPenalty?: number;
      /** Tokens the model may spend inside `<think>` before it is force-closed (0 = no cap). */
      reasoningBudget?: number;
      /** Available tools for the model to call. */
      tools?: ToolFunction[];
      /** Page facts the worker cannot observe (no window/document in a worker). */
      context?: {
        pageUrl?: string;
        pageTitle?: string;
        apps?: Array<{ id: string; title: string; tagline: string }>;
        anonToken?: string;
        apiBase?: string;
        localImageBase?: string;
      };
    }
  | { type: 'interrupt' };

export type WorkerResponse =
  | { type: 'progress'; progress?: number; file?: string }
  | { type: 'ready'; modelId: string }
  /** `channel` distinguishes chain-of-thought from the reply; absent = "answer". */
  | { type: 'token'; text: string; channel?: 'thinking' | 'answer' | 'tool' }
  /** A tool asked the HOST to do something the worker cannot do itself (open a window). */
  | { type: 'tool_action'; actions: Array<{ kind: 'open'; app: string }> }
  /** An image a tool produced — delivered out-of-band so the text stream stays text. */
  | { type: 'image'; images: Array<{ dataUrl: string; alt: string }> }
  | { type: 'done'; text: string; reasoning?: string; tokensPerSecond?: number }
  /**
   * `fatal` marks a failure the HOST must not retry. `device-lost` is the one
   * that matters: `GPUDevice.lost` resolving means the platform tore the device
   * out from under us — on Windows the overwhelmingly common cause is a TDR
   * display-driver reset. Retrying re-arms the identical reset, and the
   * visitor's SCREEN FLASHES on each one. Never retry this class.
   */
  | { type: 'error'; message: string; fatal?: 'device-lost' };

/** The slice of the Worker interface the bridge needs — Worker-like things can stand in. */
export interface WorkerLike {
  postMessage(msg: WorkerRequest): void;
  addEventListener(
    type: 'message',
    cb: (e: { data: WorkerResponse }) => void,
  ): void;
  terminate?(): void;
}

/**
 * The engine this release is pinned to. Content-addressed on the weight mirror
 * (the name carries the first 12 hex of the sha256), served with CORS `*` and
 * `immutable` caching. A new engine is a NEW file + a new awbonsai release —
 * never an overwrite, or every installed copy refuses it on the hash check.
 * Measured 2026-10-01: 290,290 B, the same bytes Veil serves at
 * aitherium.com/workers/webgpu-brain-bonsai-worker.js (which changes on every
 * Veil deploy, so it cannot carry a pin).
 */
export const DEFAULT_WORKER_SCRIPT_SHA256 =
  'c6413da0d528d8753470b4ce77541c7643a825f1d635d3e0c19132b4e8d7b8d5';
export const DEFAULT_WORKER_SCRIPT_URL =
  `https://weights.aitherium.com/awbonsai-engine-${DEFAULT_WORKER_SCRIPT_SHA256.slice(0, 12)}.js`;

export type WorkerScriptType = 'classic' | 'module' | 'auto';

let workerScriptUrl = DEFAULT_WORKER_SCRIPT_URL;
/** null = no pin (a self-hosted engine whose host chose not to pin one). */
let workerScriptSha256: string | null = DEFAULT_WORKER_SCRIPT_SHA256;

/**
 * Point the brick at another engine script. The pin follows the URL: the
 * default URL keeps the release pin; any other URL is unpinned unless a
 * `sha256` is given, because the release pin describes the default file only.
 */
export function setWorkerScriptUrl(url: string, sha256?: string | null): void {
  const pin = sha256 !== undefined
    ? normaliseSha256(sha256)
    : url === DEFAULT_WORKER_SCRIPT_URL ? DEFAULT_WORKER_SCRIPT_SHA256 : null;
  workerScriptUrl = url;
  workerScriptSha256 = pin;
}

export function getWorkerScriptUrl(): string {
  return workerScriptUrl;
}

export function getWorkerScriptSha256(): string | null {
  return workerScriptSha256;
}

/** Accepts bare hex or `sha256-`/`sha256:` prefixed hex; null/'' = no pin. */
export function normaliseSha256(v: string | null): string | null {
  if (v === null || v === '') return null;
  const hex = v.trim().toLowerCase().replace(/^sha256[-:]/, '');
  if (!/^[0-9a-f]{64}$/.test(hex)) {
    throw new Error(`awbonsai: '${v}' is not a sha256 hex digest (64 hex chars)`);
  }
  return hex;
}

export async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new Error(
      'awbonsai: crypto.subtle is unavailable (not a secure context?) — the engine hash cannot be checked, so it is not started',
    );
  }
  const digest = await subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * A static `import`/`export` at a statement start = an ES module. A minified
 * classic bundle (the engine) only has dynamic `import(`, legal in both.
 */
export function detectScriptType(source: string): 'classic' | 'module' {
  return /(^|[;\n}])\s*(import\s*(?:[\w$*{]|["'])|export\s*(?:[\w$*{]|default\b))/.test(source)
    ? 'module'
    : 'classic';
}

/**
 * Rewrite relative module specifiers (`./x`, `../x`, `/x`) to absolute URLs
 * against the ORIGINAL script location — a Blob module has no hierarchical
 * base, so they would not resolve at all. Bare and absolute specifiers stay.
 */
export function rewriteModuleSpecifiers(source: string, baseUrl: string): string {
  const abs = (_m: string, kw: string, q: string, spec: string) => `${kw}${q}${new URL(spec, baseUrl).href}${q}`;
  return source
    .replace(/(\bfrom\s*|\bimport\s*)(["'])(\.{0,2}\/[^"']*)\2/g, abs)
    .replace(/(\bimport\s*\(\s*)(["'])(\.{0,2}\/[^"']*)\2/g, abs);
}

/**
 * Prepended to the engine source. Inside a Blob worker a relative URL resolves
 * against `blob:…` and fails; this makes `fetch`, `importScripts`,
 * `XMLHttpRequest.open` and `new Worker` resolve relative strings against the
 * script's REAL location, and exposes it as `self.__AWBONSAI_SCRIPT_URL__`.
 * (The 2026-10-01 engine resolves only `/corpus/*.json` relatively — its page
 * knowledge tool; weights and kernels are absolute or inlined.)
 */
export function workerPrelude(baseUrl: string): string {
  return `/* awbonsai: relative URLs resolve against the engine's real location */
(function(){var B=${JSON.stringify(baseUrl)};var g=self;g.__AWBONSAI_SCRIPT_URL__=B;
function r(u){if(typeof u==='string'&&!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(u)){try{return new URL(u,B).href}catch(e){}}return u}
if(g.fetch){var F=g.fetch;g.fetch=function(i,o){return F.call(g,typeof i==='string'?r(i):i,o)}}
if(g.importScripts){var I=g.importScripts;g.importScripts=function(){return I.apply(g,Array.prototype.map.call(arguments,r))}}
if(g.XMLHttpRequest){var O=g.XMLHttpRequest.prototype.open;g.XMLHttpRequest.prototype.open=function(){var a=Array.prototype.slice.call(arguments);a[1]=r(a[1]);return O.apply(this,a)}}
if(g.Worker){var W=g.Worker;g.Worker=function(u,o){return new W(r(u),o)};g.Worker.prototype=W.prototype}
})();
`;
}

export interface PreparedWorkerSource {
  /** What goes in the Blob: prelude + engine (specifiers rewritten if a module). */
  source: string;
  type: 'classic' | 'module';
  sha256: string;
}

/**
 * The fetch-independent half of the spawn: verify the bytes against the pin
 * and build the Blob source. Pure, so node tests cover it without a browser.
 */
export async function prepareWorkerSource(
  bytes: ArrayBuffer,
  scriptUrl: string,
  opts: { sha256?: string | null; type?: WorkerScriptType } = {},
): Promise<PreparedWorkerSource> {
  const expected = normaliseSha256(opts.sha256 ?? null);
  const actual = await sha256Hex(bytes);
  if (expected && actual !== expected) {
    throw new WorkerIntegrityError(scriptUrl, expected, actual);
  }
  const text = new TextDecoder().decode(bytes);
  const type = !opts.type || opts.type === 'auto' ? detectScriptType(text) : opts.type;
  const body = type === 'module' ? rewriteModuleSpecifiers(text, scriptUrl) : text;
  return { source: workerPrelude(scriptUrl) + body, type, sha256: actual };
}

export interface SpawnWorkerOptions {
  /** Expected sha256 hex. Default: the configured pin (the release pin for the default URL). */
  sha256?: string | null;
  /** Worker type. `auto` (default) sniffs the source for static import/export. */
  type?: WorkerScriptType;
  /** Injectable fetch (tests). */
  fetch?: typeof fetch;
}

/**
 * Spawn the engine worker.
 *
 * `new Worker(url)` is same-origin only: a browser throws SecurityError for an
 * engine on another host even when it sends CORS headers, so a third-party site
 * could never start the default engine. Instead: fetch the script (CORS), check
 * its sha256 against the pin (a mismatch is refused, never started), and start
 * it from a Blob URL behind a prelude that resolves relative URLs against the
 * script's real location. A page CSP must allow `worker-src blob:`.
 */
export async function spawnWorker(scriptUrl?: string, opts: SpawnWorkerOptions = {}): Promise<WorkerLike> {
  if (typeof Worker === 'undefined' || typeof Blob === 'undefined' || typeof URL.createObjectURL !== 'function') {
    throw new Error('No Worker/Blob global — awbonsai runs in a browser tab');
  }
  const base = typeof location !== 'undefined' ? location.href : undefined;
  const url = new URL(scriptUrl ?? workerScriptUrl, base).href;
  let sha256: string | null;
  if (opts.sha256 !== undefined) sha256 = opts.sha256;
  else if (scriptUrl === undefined) sha256 = workerScriptSha256;
  else sha256 = url === DEFAULT_WORKER_SCRIPT_URL ? DEFAULT_WORKER_SCRIPT_SHA256 : null;

  const doFetch = opts.fetch ?? fetch;
  let res: Response;
  try {
    res = await doFetch(url, { mode: 'cors', credentials: 'omit' });
  } catch (e) {
    throw new Error(`awbonsai: could not fetch the engine script ${url} (${String(e)}) — it must be served with CORS`);
  }
  if (!res.ok) {
    throw new Error(`awbonsai: the engine script ${url} answered HTTP ${res.status}`);
  }
  const prepared = await prepareWorkerSource(await res.arrayBuffer(), url, { sha256, type: opts.type });
  const blobUrl = URL.createObjectURL(new Blob([prepared.source], { type: 'text/javascript' }));
  try {
    const worker = new Worker(blobUrl, prepared.type === 'module' ? { type: 'module' } : undefined);
    const terminate = worker.terminate.bind(worker);
    worker.terminate = () => {
      terminate();
      URL.revokeObjectURL(blobUrl);
    };
    return worker as unknown as WorkerLike;
  } catch (e) {
    URL.revokeObjectURL(blobUrl);
    throw e;
  }
}

export interface GenerateHandlers {
  onToken?: (text: string) => void;
  onThinking?: (text: string) => void;
  onProgress?: (p: { progress?: number; file?: string }) => void;
  onToolAction?: (actions: Array<{ kind: 'open'; app: string }>) => void;
  onImage?: (images: Array<{ dataUrl: string; alt: string }>) => void;
}

export interface GenerateResult {
  /** The FULL assembled reply (the wire contract's `done.text`). */
  text: string;
  reasoning?: string;
  tokensPerSecond?: number;
}

export interface BridgeGenerateOptions extends GenerateHandlers {
  maxTokens?: number;
  temperature?: number;
  topK?: number;
  topP?: number;
  repetitionPenalty?: number;
  reasoningBudget?: number;
  tools?: ToolFunction[];
  context?: WorkerRequest extends { type: 'generate' } ? NonNullable<WorkerRequest['context']> : never;
  /** Abort interrupts the running turn (posts `interrupt`) and rejects with GenerationAbortedError. */
  signal?: AbortSignal;
}

interface PendingGenerate {
  resolve: (r: GenerateResult) => void;
  reject: (e: Error) => void;
  handlers: GenerateHandlers;
}

export interface WorkerBridge {
  /** Post `load` and resolve on `ready`. Rejects on `error` — and immediately if the device was already lost. */
  load(modelId: string, onProgress?: (p: { progress?: number; file?: string }) => void): Promise<void>;
  /** Post `generate`, stream through the handlers, resolve on `done`. */
  generate(messages: ChatMessage[], opts?: BridgeGenerateOptions): Promise<GenerateResult>;
  /** Post `interrupt` — the running turn stops; the worker stays loaded. */
  interrupt(): void;
  /** Tear the worker down. The bridge is dead after this. */
  terminate(): void;
  /** Latch set once a fatal device-lost error has been seen; never cleared. */
  readonly deviceLost: string | null;
}

/**
 * Adapt a Worker-like to promises. One listener for the whole lifetime; the
 * wire contract is strictly request/response so a single pending slot per
 * operation is correct. All events are ALSO forwarded to `onEvent` when given,
 * for observability.
 */
export function createWorkerBridge(
  worker: WorkerLike,
  deps?: { onEvent?: (msg: WorkerResponse) => void },
): WorkerBridge {
  let deviceLost: string | null = null;
  let pendingLoad: {
    resolve: () => void;
    reject: (e: Error) => void;
    onProgress?: (p: { progress?: number; file?: string }) => void;
  } | null = null;
  let pendingGenerate: PendingGenerate | null = null;

  function failPending(e: Error): void {
    if (pendingLoad) { pendingLoad.reject(e); pendingLoad = null; }
    if (pendingGenerate) { pendingGenerate.reject(e); pendingGenerate = null; }
  }

  worker.addEventListener('message', (e) => {
    const msg = e.data;
    if (deps?.onEvent) deps.onEvent(msg);
    switch (msg.type) {
      case 'progress':
        pendingLoad?.onProgress?.({ progress: msg.progress, file: msg.file });
        pendingGenerate?.handlers.onProgress?.({ progress: msg.progress, file: msg.file });
        break;
      case 'ready':
        if (pendingLoad) { pendingLoad.resolve(); pendingLoad = null; }
        break;
      case 'token':
        if (msg.channel === 'thinking') {
          pendingGenerate?.handlers.onThinking?.(msg.text);
        } else {
          pendingGenerate?.handlers.onToken?.(msg.text);
        }
        break;
      case 'tool_action':
        pendingGenerate?.handlers.onToolAction?.(msg.actions);
        break;
      case 'image':
        pendingGenerate?.handlers.onImage?.(msg.images);
        break;
      case 'done':
        if (pendingGenerate) {
          pendingGenerate.resolve({
            text: msg.text,
            reasoning: msg.reasoning,
            tokensPerSecond: msg.tokensPerSecond,
          });
          pendingGenerate = null;
        }
        break;
      case 'error':
        if (msg.fatal === 'device-lost') {
          deviceLost = msg.message;
        }
        failPending(
          msg.fatal === 'device-lost'
            ? new DeviceLostError(msg.message)
            : new Error(msg.message),
        );
        break;
      default:
        break;
    }
  });

  return {
    get deviceLost() {
      return deviceLost;
    },

    async load(modelId: string, onProgress?: (p: { progress?: number; file?: string }) => void): Promise<void> {
      if (deviceLost) {
        throw new DeviceLostError(`refusing to load — the GPU device was already lost (${deviceLost})`);
      }
      if (pendingLoad || pendingGenerate) {
        throw new Error('awbonsai: a load or generate is already in flight');
      }
      return new Promise<void>((resolve, reject) => {
        pendingLoad = { resolve, reject, onProgress };
        worker.postMessage({ type: 'load', modelId });
      });
    },

    generate(messages: ChatMessage[], opts: BridgeGenerateOptions = {}): Promise<GenerateResult> {
      if (deviceLost) {
        return Promise.reject(
          new DeviceLostError(`refusing to generate — the GPU device was already lost (${deviceLost})`),
        );
      }
      if (pendingLoad || pendingGenerate) {
        return Promise.reject(new Error('awbonsai: a load or generate is already in flight'));
      }
      return new Promise<GenerateResult>((resolve, reject) => {
        const onAbort = () => {
          worker.postMessage({ type: 'interrupt' });
          if (pendingGenerate) { pendingGenerate = null; }
          reject(new GenerationAbortedError('generation aborted by the caller'));
        };
        pendingGenerate = {
          resolve,
          reject,
          handlers: {
            onToken: opts.onToken,
            onThinking: opts.onThinking,
            onProgress: opts.onProgress,
            onToolAction: opts.onToolAction,
            onImage: opts.onImage,
          },
        };
        if (opts.signal) {
          if (opts.signal.aborted) { onAbort(); return; }
          opts.signal.addEventListener('abort', onAbort, { once: true });
        }
        worker.postMessage({
          type: 'generate',
          messages,
          ...(opts.maxTokens !== undefined ? { maxTokens: opts.maxTokens } : {}),
          ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
          ...(opts.topK !== undefined ? { topK: opts.topK } : {}),
          ...(opts.topP !== undefined ? { topP: opts.topP } : {}),
          ...(opts.repetitionPenalty !== undefined ? { repetitionPenalty: opts.repetitionPenalty } : {}),
          ...(opts.reasoningBudget !== undefined ? { reasoningBudget: opts.reasoningBudget } : {}),
          ...(opts.tools !== undefined ? { tools: opts.tools } : {}),
          ...(opts.context !== undefined ? { context: opts.context } : {}),
        });
      });
    },

    interrupt(): void {
      worker.postMessage({ type: 'interrupt' });
    },

    terminate(): void {
      worker.terminate?.();
    },
  };
}
