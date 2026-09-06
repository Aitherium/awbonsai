/**
 * awbonsai — the in-browser Bonsai lane as a library.
 *
 * One npm install. A real model on the visitor's own GPU. No server round trip,
 * no account, no upload. The engine (WGSL kernels, tokenizer, GGUF decoder) is
 * NOT vendored here — it loads at runtime from the weight mirror as a worker
 * script; this package is the API contract, the model catalogue with honest
 * capability metadata, and the loader with the consent gate in front of it.
 *
 * The consent gate is the BCG rule set (never auto-download without consent;
 * unset = off; the surface rule runs BEFORE the first byte):
 *
 *   import { grantBonsaiConsent } from '@aitherium/awbonsai'
 *   // show your own "load a model in your browser?" UI, then:
 *   grantBonsaiConsent(false) // false = this one load only, not a standing "auto" yes
 *   const model = await loadModel('bonsai-1.7b')
 *   const reply = await model.generate('why is the sky blue?', {
 *     onToken: (t) => el.textContent += t,
 *   })
 *
 * A stranger's own site is refused by the default surface rule until it is
 * configured — see `configureAwbonsai({ allowedHosts })` in the README.
 */

export * from './errors.js';
export * from './models.js';
export * from './is-supported.js';
export * from './consent.js';
export * from './worker-core.js';

import {
  BrowserRequiredError,
  ConsentRequiredError,
  ModelNotFoundError,
  SurfaceRefusedError,
} from './errors.js';
import {
  BONSAI_MODELS,
  DEFAULT_MODEL_ID,
  getBonsaiModel,
  setMirrorBase,
  type BonsaiModel,
} from './models.js';
import { currentSurfaceRefusal, readBonsaiConsent, setConsentSettings, type ConsentStorage } from './consent.js';
import {
  createWorkerBridge,
  setWorkerScriptUrl,
  spawnWorker,
  type GenerateResult,
  type WorkerLike,
} from './worker-core.js';

export interface AwbonsaiConfig {
  /**
   * Where the weight files are fetched from. Default: `https://weights.aitherium.com`
   * (the measured-working mirror). `null` / `''` / `'none'` genuinely disables
   * the mirror and sends browsers to the upstream host.
   */
  mirrorBase?: string | null;
  /** Where the engine WORKER SCRIPT is fetched from at runtime. Default: the mirror. */
  workerScriptUrl?: string;
  /** localStorage key holding the visitor's consent record. */
  consentKey?: string;
  /** Hosts allowed to run a model. A stranger's site is refused until it is listed here. */
  allowedHosts?: readonly string[];
  /** Paths on an allowed host that are still reading surfaces (refused for everybody). */
  deniedPaths?: readonly string[];
  /**
   * A custom surface rule replacing the allowlist entirely (return null = allowed,
   * a string = refused with that reason). Setting this makes the CALLER the gate.
   */
  surfaceRule?: ((host: string, pathname: string) => string | null) | null;
  /** Injectable storage for the consent record (tests, apps with their own layer). */
  storage?: ConsentStorage | null;
}

/** Configure the brick. Any subset; the rest keeps its previous value. */
export function configureAwbonsai(cfg: AwbonsaiConfig): void {
  if (cfg.mirrorBase !== undefined) setMirrorBase(cfg.mirrorBase);
  if (cfg.workerScriptUrl !== undefined) setWorkerScriptUrl(cfg.workerScriptUrl);
  setConsentSettings({
    consentKey: cfg.consentKey,
    allowedHosts: cfg.allowedHosts,
    deniedPaths: cfg.deniedPaths,
    surfaceRule: cfg.surfaceRule,
    storage: cfg.storage,
  });
}

export interface LoadModelOptions {
  /**
   * Assert consent for THIS load. `true` = the caller has shown its own consent
   * UI and the visitor said yes; omit to require a stored grant
   * (`grantBonsaiConsent()`). Fail-closed: no consent, no download, ever.
   */
  consent?: boolean;
  /** Engine script URL for this load (overrides the configured default). */
  workerScriptUrl?: string;
  onProgress?: (p: { progress?: number; file?: string }) => void;
}

export interface SessionGenerateOptions {
  system?: string;
  maxTokens?: number;
  temperature?: number;
  topK?: number;
  topP?: number;
  repetitionPenalty?: number;
  reasoningBudget?: number;
  tools?: import('./worker-core.js').ToolFunction[];
  onToken?: (text: string) => void;
  onThinking?: (text: string) => void;
  onProgress?: (p: { progress?: number; file?: string }) => void;
  /** Abort interrupts the turn and rejects with GenerationAbortedError. */
  signal?: AbortSignal;
}

export interface BonsaiSession {
  modelId: string;
  model: BonsaiModel;
  generate(prompt: string, opts?: SessionGenerateOptions): Promise<GenerateResult>;
  /** Stop the current turn; the worker stays loaded. */
  interrupt(): void;
  /** Tear the worker down. The session is dead after this. */
  dispose(): void;
}

/**
 * Load a model and return a session.
 *
 * ORDER OF GATES (BCG002 — both run BEFORE the first byte is fetched):
 *  1. surface rule  — a reading surface is refused for everybody, consented or not;
 *  2. consent       — a stored grant, or the caller asserting `consent: true`.
 */
export async function loadModel(
  modelId: string = DEFAULT_MODEL_ID,
  opts: LoadModelOptions = {},
): Promise<BonsaiSession> {
  const model = getBonsaiModel(modelId);
  if (!model) {
    throw new ModelNotFoundError(
      `unknown model id '${modelId}' — known ids: ${BONSAI_MODELS.map((m) => m.id).join(', ')}`,
    );
  }

  // Gate 1: the surface. A property of the PAGE, not of the visitor — no stored
  // preference can unlock it. Skipped only when there is no window at all
  // (Node, SSR), where nothing can run anyway and the Worker check below fails.
  if (typeof window !== 'undefined') {
    const refusal = currentSurfaceRefusal();
    if (refusal) throw new SurfaceRefusedError(refusal);
  }

  // Gate 2: consent. Unset = off. Storage unreadable = off. Only an explicit
  // stored grant or an explicit per-call assertion unlocks a download.
  if (!opts.consent) {
    const consent = readBonsaiConsent();
    if (!consent) {
      throw new ConsentRequiredError(
        'no consent record for this device. Show your own prompt, then call ' +
        'grantBonsaiConsent(auto) — or pass { consent: true } when the visitor ' +
        'has just agreed in your UI. Nothing downloads until then.',
      );
    }
  }

  // The engine worker runs in a tab; there is no tab here.
  if (typeof window === 'undefined' || typeof Worker === 'undefined') {
    throw new BrowserRequiredError('awbonsai runs in a browser tab — no Worker available in this environment');
  }

  let worker: WorkerLike | null = null;
  try {
    worker = spawnWorker(opts.workerScriptUrl);
  } catch (e) {
    throw new BrowserRequiredError(`could not spawn the engine worker: ${String(e)}`);
  }

  const bridge = createWorkerBridge(worker);
  try {
    await bridge.load(modelId);
  } catch (e) {
    worker.terminate?.();
    throw e;
  }

  const generate = async (prompt: string, gopts: SessionGenerateOptions = {}): Promise<GenerateResult> => {
    const messages: import('./worker-core.js').ChatMessage[] = [];
    if (gopts.system) messages.push({ role: 'system', content: gopts.system });
    messages.push({ role: 'user', content: prompt });
    return bridge.generate(messages, {
      maxTokens: gopts.maxTokens,
      temperature: gopts.temperature,
      topK: gopts.topK,
      topP: gopts.topP,
      repetitionPenalty: gopts.repetitionPenalty,
      reasoningBudget: gopts.reasoningBudget,
      tools: gopts.tools,
      onToken: gopts.onToken,
      onThinking: gopts.onThinking,
      onProgress: gopts.onProgress,
      signal: gopts.signal,
    });
  };

  return {
    modelId: model.id,
    model,
    generate,
    interrupt: () => bridge.interrupt(),
    dispose: () => bridge.terminate(),
  };
}

export interface GeneratePromptOptions extends SessionGenerateOptions {
  /** Model to use; defaults to the catalogue default (bonsai-1.7b). */
  modelId?: string;
  /** See LoadModelOptions.consent. */
  consent?: boolean;
  /** Engine script URL for this call (overrides the configured default). */
  workerScriptUrl?: string;
  onProgress?: (p: { progress?: number; file?: string }) => void;
}

/**
 * Convenience one-shot: load (with the same consent gates) and generate.
 * Returns the full reply; stream it with `onToken`/`onThinking`.
 */
export async function generate(prompt: string, opts: GeneratePromptOptions = {}): Promise<GenerateResult> {
  const session = await loadModel(opts.modelId ?? DEFAULT_MODEL_ID, {
    consent: opts.consent,
    workerScriptUrl: opts.workerScriptUrl,
    onProgress: opts.onProgress,
  });
  try {
    return await session.generate(prompt, opts);
  } finally {
    session.dispose();
  }
}
