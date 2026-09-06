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

import { DeviceLostError, GenerationAbortedError } from './errors.js';

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

/** Where the engine worker script is fetched from at runtime. Override point. */
const DEFAULT_WORKER_SCRIPT_URL = 'https://weights.aitherium.com/bonsai-worker.js';

let workerScriptUrl = DEFAULT_WORKER_SCRIPT_URL;

export function setWorkerScriptUrl(url: string): void {
  workerScriptUrl = url;
}

export function getWorkerScriptUrl(): string {
  return workerScriptUrl;
}

/** Spawn the engine worker from its script URL. Throws outside a browser tab. */
export function spawnWorker(scriptUrl?: string): WorkerLike {
  if (typeof Worker === 'undefined') {
    throw new Error('No Worker global — awbonsai runs in a browser tab');
  }
  return new Worker(scriptUrl ?? workerScriptUrl);
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
  load(modelId: string): Promise<void>;
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
  let pendingLoad: { resolve: () => void; reject: (e: Error) => void } | null = null;
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

    async load(modelId: string): Promise<void> {
      if (deviceLost) {
        throw new DeviceLostError(`refusing to load — the GPU device was already lost (${deviceLost})`);
      }
      if (pendingLoad || pendingGenerate) {
        throw new Error('awbonsai: a load or generate is already in flight');
      }
      return new Promise<void>((resolve, reject) => {
        pendingLoad = { resolve, reject };
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
