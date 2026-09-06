/**
 * awbonsai tests — node:test, plain ESM, importing the BUILT artifact
 * (`dist/`), so this asserts the package as it will actually be consumed.
 * Run with `npm test` (builds first) or `node --test test/`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  BONSAI_MODELS,
  DEFAULT_MODEL_ID,
  getBonsaiModel,
  browserRunnableModels,
  resolveBonsaiUrl,
  mirrorUrls,
  suggestModelId,
  pickContext,
  setMirrorBase,
  getMirrorBase,
  gpuSizeCeilingMb,
  describeAdapter,
  assessSupport,
  isSupported,
  classifyAdapter,
  isMobileDevice,
  autoBootAllowed,
  gpuLaneAllowed,
  bonsaiSurfaceRefusal,
  isBonsaiSurfaceAllowed,
  matchesPathPrefix,
  readBonsaiConsent,
  grantBonsaiConsent,
  revokeBonsaiConsent,
  bonsaiMayAutoLoad,
  hasBonsaiConsent,
  setConsentSettings,
  configureAwbonsai,
  createWorkerBridge,
  spawnWorker,
  setWorkerScriptUrl,
  getWorkerScriptUrl,
  loadModel,
  generate,
  ConsentRequiredError,
  BrowserRequiredError,
  ModelNotFoundError,
  SurfaceRefusedError,
  DeviceLostError,
  GenerationAbortedError,
} from '../dist/index.js';

/** A fake Worker that speaks the wire protocol, driven from the test. */
function makeFakeWorker({ autoReady = true } = {}) {
  const listeners = new Set();
  const posted = [];
  return {
    posted,
    listeners,
    emit(msg) {
      for (const cb of listeners) cb({ data: msg });
    },
    postMessage(msg) {
      posted.push(msg);
      if (autoReady && msg.type === 'load') {
        // simulate the engine answering ready on the next tick
        queueMicrotask(() => this.emit({ type: 'ready', modelId: msg.modelId }));
      }
    },
    addEventListener(type, cb) {
      if (type === 'message') listeners.add(cb);
    },
    terminate() { this.terminated = true; },
    terminated: false,
  };
}

function fakeStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
  };
}

// ---------------------------------------------------------------------------
// 1. The catalogue is well-formed — every entry a real, loadable promise.
// ---------------------------------------------------------------------------
test('catalogue: four models, unique ids, honest sizes/quants/contexts', () => {
  assert.equal(BONSAI_MODELS.length, 4);
  const ids = new Set(BONSAI_MODELS.map((m) => m.id));
  assert.equal(ids.size, 4, 'ids must be unique');

  const known = {
    'bonsai-1.7b': { sizeMb: 236, contextWindow: 32768, quant: 'Q1_0', arch: 'qwen3' },
    'bonsai-4b': { sizeMb: 545, contextWindow: 32768, quant: 'Q1_0', arch: 'qwen3' },
    'bonsai-8b': { sizeMb: 1104, contextWindow: 65536, quant: 'Q1_0', arch: 'qwen3' },
    'bonsai-27b-text': { sizeMb: 3627, contextWindow: 262144, quant: 'Q1_0', arch: 'qwen35' },
  };
  for (const m of BONSAI_MODELS) {
    assert.ok(m.sizeMb > 0, `${m.id}: sizeMb > 0`);
    assert.ok(Number.isInteger(m.contextWindow) && m.contextWindow > 0, `${m.id}: contextWindow`);
    assert.equal(m.contextWindow & (m.contextWindow - 1), 0, `${m.id}: contextWindow is a power of two`);
    assert.ok(/^[A-Za-z0-9_.-]+$/.test(m.quant), `${m.id}: quant is a plain token`);
    assert.match(m.url, /^https:\/\/huggingface\.co\/prism-ml\//, `${m.id}: upstream url host`);
    assert.match(m.url, /Q1_0\.gguf$/, `${m.id}: url names its quant`);
    assert.ok(['qwen3', 'qwen35'].includes(m.arch), `${m.id}: arch is a known architecture`);
    const expect = known[m.id];
    assert.ok(expect, `${m.id}: no expected entry (catalogue grew unexpectedly?)`);
    assert.equal(m.sizeMb, expect.sizeMb, `${m.id}: size`);
    assert.equal(m.contextWindow, expect.contextWindow, `${m.id}: context`);
    assert.equal(m.quant, expect.quant, `${m.id}: quant`);
    assert.equal(m.arch, expect.arch, `${m.id}: arch`);
  }
});

test('catalogue: lookups, runnable set, mirror-first resolution', () => {
  assert.equal(getBonsaiModel('bonsai-8b')?.sizeMb, 1104);
  assert.equal(getBonsaiModel('does-not-exist'), undefined);
  assert.equal(DEFAULT_MODEL_ID, 'bonsai-1.7b');
  assert.equal(browserRunnableModels().length, 4, 'all four are browser-runnable');

  // Mirror-first: the owned host is what browsers download from.
  const url = resolveBonsaiUrl('bonsai-1.7b');
  assert.ok(url.startsWith('https://weights.aitherium.com/'), `mirror-first: ${url}`);
  assert.ok(url.endsWith('Bonsai-1.7B-Q1_0.gguf'), 'filename is preserved on the mirror');
  assert.equal(url, resolveBonsaiUrl('bonsai-1.7b'));

  // Unknown id falls back to the default model, mirror-first too.
  assert.ok(resolveBonsaiUrl('nope').startsWith('https://weights.aitherium.com/'));

  // mirrorUrls keeps [primary, mirror] ordering.
  const urls = mirrorUrls({ url: 'https://huggingface.co/prism-ml/Bonsai-4B-gguf/resolve/main/Bonsai-4B-Q1_0.gguf' });
  assert.equal(urls.length, 2);
  assert.match(urls[0], /^https:\/\/huggingface\.co\//);
  assert.match(urls[1], /^https:\/\/weights\.aitherium\.com\//);

  // Disabling the mirror leaves only the primary.
  setMirrorBase('none');
  assert.equal(getMirrorBase(), '');
  assert.equal(resolveBonsaiUrl('bonsai-1.7b'), 'https://huggingface.co/prism-ml/Bonsai-1.7B-gguf/resolve/main/Bonsai-1.7B-Q1_0.gguf');
  setMirrorBase(undefined); // back to the default
  assert.equal(getMirrorBase(), 'https://weights.aitherium.com');
});

test('catalogue: sizing helpers stay inside the catalogue', () => {
  // pickContext never exceeds the model's own window (deviceMemory absent in Node).
  const small = getBonsaiModel('bonsai-1.7b');
  const big = getBonsaiModel('bonsai-27b-text');
  assert.ok(pickContext(small) <= small.contextWindow);
  assert.ok(pickContext(big) <= big.contextWindow);

  // An iGPU is capped at the lightest model; a discrete card has no opinion.
  const igpuCeiling = gpuSizeCeilingMb({ vendor: 'intel', architecture: 'gen-12lp' });
  assert.equal(igpuCeiling, 236);
  const nvidia = gpuSizeCeilingMb({ vendor: 'nvidia', architecture: 'ada-lovelace' });
  assert.equal(nvidia, Infinity);

  // suggestModelId defaults in Node (no navigator) rather than guessing.
  // The hint-clamping path is exercised above via gpuSizeCeilingMb, which is
  // the pure decision the clamp is built on.
  assert.equal(suggestModelId(), DEFAULT_MODEL_ID);

  assert.equal(describeAdapter({ vendor: 'nvidia', architecture: 'ada-lovelace' }), 'nvidia · ada-lovelace');
  assert.equal(describeAdapter({ isFallbackAdapter: true }), 'cpu (no gpu found)');
});

// ---------------------------------------------------------------------------
// 2. Honest capability detection — the null-adapter cases.
// ---------------------------------------------------------------------------
test('detection: null adapter hint never reads as allowed', () => {
  // Safari/iPhone shape: WebGPU API present, but requestAdapter gave us nothing.
  const report = assessSupport({
    hasNavigator: true,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15',
    maxTouchPoints: 5,
    hasWebGpu: true,
    hasWebNn: false,
    adapter: null,
  });
  assert.equal(report.supported, false);
  assert.ok(report.reason, 'a false supported carries a reason');
  assert.ok(report.reason.includes('mobile'), 'the mobile refusal names mobile');

  // Desktop Safari: null adapter, NOT mobile -> refused for a different reason.
  const safari = assessSupport({
    hasNavigator: true,
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15',
    maxTouchPoints: 0,
    hasWebGpu: true,
    hasWebNn: false,
    adapter: null,
  });
  assert.equal(safari.supported, false);
  assert.match(safari.reason, /no WebGPU adapter/);

  // No navigator at all (SSR) — refused, and never "allowed by default".
  const ssr = assessSupport({
    hasNavigator: false, userAgent: '', maxTouchPoints: 0,
    hasWebGpu: false, hasWebNn: false, adapter: null,
  });
  assert.equal(ssr.supported, false);

  // A software fallback with an EMPTY vendor classifies as software, not unknown.
  const fallback = assessSupport({
    hasNavigator: true,
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36',
    maxTouchPoints: 0,
    hasWebGpu: true,
    hasWebNn: false,
    adapter: { isFallbackAdapter: true },
  });
  assert.equal(fallback.gpuClass, 'software');
  assert.equal(fallback.supported, false);

  // A real adapter with a real vendor is supported.
  const real = assessSupport({
    hasNavigator: true,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    maxTouchPoints: 0,
    hasWebGpu: true,
    hasWebNn: false,
    adapter: { vendor: 'nvidia', architecture: 'ada-lovelace' },
  });
  assert.equal(real.supported, true);
  assert.equal(real.reason, null);
});

test('detection: classifyAdapter / isMobileDevice / autoBootAllowed', () => {
  assert.equal(classifyAdapter(undefined), 'unknown');
  assert.equal(classifyAdapter(null), 'unknown');
  assert.equal(classifyAdapter({}), 'unknown');
  assert.equal(classifyAdapter({ vendor: 'nvidia' }), 'unknown');
  assert.equal(classifyAdapter({ vendor: 'INTEL' }), 'integrated');
  assert.equal(classifyAdapter({ vendor: 'microsoft' }), 'software');
  assert.equal(classifyAdapter({ vendor: 'nvidia', isFallbackAdapter: true }), 'software');

  // iPadOS 13+ sends a DESKTOP Safari UA — the touch check catches it.
  assert.equal(isMobileDevice('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15', 5), true);
  assert.equal(isMobileDevice('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15', 0), false);
  assert.equal(isMobileDevice('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)'), true);

  // Null hint + mobile = NO auto-boot (the exact BIH003 case).
  assert.equal(autoBootAllowed(null, 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)', 5), false);
  // Null hint + desktop = "no opinion" (defer), not a refusal.
  assert.equal(autoBootAllowed(null), true);
  // Software = never auto-boot.
  assert.equal(autoBootAllowed({ isFallbackAdapter: true }), false);
  assert.equal(gpuLaneAllowed('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)', 5), false);
  assert.equal(gpuLaneAllowed('Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 0), true);
});

// ---------------------------------------------------------------------------
// 3. Consent: fail-closed, unset = off, reading surfaces refused for everybody.
// ---------------------------------------------------------------------------
test('consent: surface rule is fail-closed and segment-boundary exact', () => {
  // Platform defaults: the app apex is allowed, the blog on the SAME host is not.
  assert.equal(isBonsaiSurfaceAllowed('aitherium.com', '/'), true);
  assert.equal(isBonsaiSurfaceAllowed('aitherium.com', '/os'), true);
  assert.ok(bonsaiSurfaceRefusal('aitherium.com', '/blog'));
  assert.ok(bonsaiSurfaceRefusal('aitherium.com', '/blog/a-post'));
  // Segment boundary: /blogging-app is NOT the blog.
  assert.equal(isBonsaiSurfaceAllowed('aitherium.com', '/blogging-app'), true);
  assert.equal(matchesPathPrefix('/blogging-app', '/blog'), false);
  // A stranger's host is refused by default.
  assert.ok(bonsaiSurfaceRefusal('example.org', '/'));
  // No host at all is refused.
  assert.ok(bonsaiSurfaceRefusal('', '/'));
});

test('consent: unreadable storage is not consent (fail-closed)', () => {
  configureAwbonsai({
    storage: fakeStorage({ 'awbonsai-consent': 'not json at all {' }),
  });
  assert.equal(readBonsaiConsent(), null);
  assert.equal(hasBonsaiConsent(), false);
  assert.equal(bonsaiMayAutoLoad(), false);

  // A record with granted:false (older shape / revoked) is also not consent.
  configureAwbonsai({
    storage: fakeStorage({ 'awbonsai-consent': JSON.stringify({ granted: false, auto: true }) }),
  });
  assert.equal(readBonsaiConsent(), null);

  // No storage at all -> null, never a default yes.
  configureAwbonsai({ storage: null });
  assert.equal(readBonsaiConsent(), null);
});

test('consent: grant -> read round trip, and auto is a SEPARATE standing yes', () => {
  const storage = fakeStorage();
  configureAwbonsai({ storage, surfaceRule: () => null });
  try {
    assert.equal(readBonsaiConsent(), null);
    grantBonsaiConsent(false); // one-time yes
    const c = readBonsaiConsent();
    assert.ok(c && c.granted === true && c.auto === false);
    assert.equal(hasBonsaiConsent(), true);
    // A bare grant must NOT satisfy the standing auto-load question.
    assert.equal(bonsaiMayAutoLoad(), false);
    grantBonsaiConsent(true); // now tick the box
    const c2 = readBonsaiConsent();
    assert.ok(c2 && c2.auto === true);
    revokeBonsaiConsent();
    assert.equal(readBonsaiConsent(), null);
  } finally {
    configureAwbonsai({ storage: null, surfaceRule: null });
  }
});

test('consent: a custom surfaceRule overrides the allowlist', () => {
  configureAwbonsai({ surfaceRule: (host) => (host === 'my.app' ? null : 'not my.app') });
  try {
    assert.equal(isBonsaiSurfaceAllowed('my.app', '/'), true);
    assert.ok(bonsaiSurfaceRefusal('other.app', '/'));
  } finally {
    configureAwbonsai({ surfaceRule: null }); // null = back to the vendored allowlist
  }
  assert.equal(isBonsaiSurfaceAllowed('my.app', '/'), false);
});

// ---------------------------------------------------------------------------
// 4. The bridge: the wire contract, streaming, the device-lost latch.
// ---------------------------------------------------------------------------
test('bridge: load resolves on ready, rejects on error, streams tokens', async () => {
  const worker = makeFakeWorker();
  const seen = [];
  const bridge = createWorkerBridge(worker, { onEvent: (m) => seen.push(m.type) });

  await bridge.load('bonsai-1.7b');
  assert.equal(worker.posted[0].type, 'load');
  assert.equal(worker.posted[0].modelId, 'bonsai-1.7b');
  assert.ok(seen.includes('ready'));

  const tokens = [];
  const promise = bridge.generate(
    [{ role: 'user', content: 'hi' }],
    {
      maxTokens: 16,
      temperature: 0.7,
      onToken: (t) => tokens.push(t),
      onProgress: () => {},
    },
  );
  assert.equal(worker.posted[1].type, 'generate');
  assert.equal(worker.posted[1].maxTokens, 16);
  worker.emit({ type: 'progress', progress: 0.5, file: 'Bonsai-1.7B-Q1_0.gguf' });
  worker.emit({ type: 'token', text: 'hel', channel: 'answer' });
  worker.emit({ type: 'token', text: 'lo', channel: 'thinking' });
  worker.emit({ type: 'done', text: 'hello', reasoning: 'hi', tokensPerSecond: 12.5 });
  const result = await promise;
  assert.equal(result.text, 'hello');
  assert.equal(result.reasoning, 'hi');
  assert.equal(result.tokensPerSecond, 12.5);
  assert.deepEqual(tokens, ['hel']); // thinking went to onThinking, not onToken
});

test('bridge: error rejects; device-lost latches and poisons later calls', async () => {
  const worker = makeFakeWorker({ autoReady: false });
  const bridge = createWorkerBridge(worker);

  const load = bridge.load('bonsai-8b');
  worker.emit({ type: 'error', message: 'boom', fatal: 'device-lost' });
  await assert.rejects(load, DeviceLostError);
  assert.ok(bridge.deviceLost, 'the latch is set');

  await assert.rejects(bridge.load('bonsai-8b'), DeviceLostError);
  await assert.rejects(bridge.generate([{ role: 'user', content: 'x' }]), DeviceLostError);
});

test('bridge: abort posts interrupt and rejects with GenerationAbortedError', async () => {
  const worker = makeFakeWorker(); // autoReady: load answers 'ready' on its own
  const bridge = createWorkerBridge(worker);
  await bridge.load('bonsai-1.7b');
  const ac = new AbortController();
  const promise = bridge.generate([{ role: 'user', content: 'x' }], { signal: ac.signal });
  ac.abort();
  await assert.rejects(promise, GenerationAbortedError);
  assert.ok(worker.posted.some((m) => m.type === 'interrupt'));
});

test('bridge: a second in-flight op is refused', async () => {
  const worker = makeFakeWorker({ autoReady: false });
  const bridge = createWorkerBridge(worker);
  const first = bridge.load('bonsai-1.7b');
  await assert.rejects(bridge.load('bonsai-4b'), /already in flight/);
  worker.emit({ type: 'ready', modelId: 'bonsai-1.7b' });
  await first;
});

// ---------------------------------------------------------------------------
// 5. The loader: gates run BEFORE the worker is spawned.
// ---------------------------------------------------------------------------
test('loader: no consent -> ConsentRequiredError, before any spawn', async () => {
  configureAwbonsai({ storage: null, surfaceRule: () => null });
  try {
    await assert.rejects(loadModel('bonsai-1.7b'), ConsentRequiredError);
  } finally {
    configureAwbonsai({ storage: null });
  }
});

test('loader: unknown model id -> ModelNotFoundError, before consent', async () => {
  await assert.rejects(loadModel('bonsai-99b'), ModelNotFoundError);
});

test('loader: with consent, but no browser -> BrowserRequiredError (consent gate already passed)', async () => {
  configureAwbonsai({ storage: fakeStorage({ 'awbonsai-consent': JSON.stringify({ granted: true, auto: false, at: new Date().toISOString() }) }) });
  try {
    await assert.rejects(loadModel('bonsai-1.7b'), BrowserRequiredError);
  } finally {
    configureAwbonsai({ storage: null });
  }
});

test('loader: generate() one-shot applies the same consent gate', async () => {
  configureAwbonsai({ storage: null });
  try {
    await assert.rejects(generate('hi'), ConsentRequiredError);
  } finally {
    configureAwbonsai({ storage: null });
  }
});

// ---------------------------------------------------------------------------
// 6. The public surface is complete — every documented name resolves.
// ---------------------------------------------------------------------------
test('exports: the documented API is present', () => {
  const api = {
    loadModel, generate, configureAwbonsai,
    BONSAI_MODELS, DEFAULT_MODEL_ID, getBonsaiModel, browserRunnableModels,
    resolveBonsaiUrl, mirrorUrls, setMirrorBase, getMirrorBase,
    suggestModelId, pickContext, gpuSizeCeilingMb, describeAdapter,
    isSupported, assessSupport, classifyAdapter, isMobileDevice,
    gpuLaneAllowed, autoBootAllowed,
    bonsaiSurfaceRefusal, isBonsaiSurfaceAllowed, matchesPathPrefix,
    readBonsaiConsent, grantBonsaiConsent, revokeBonsaiConsent,
    bonsaiMayAutoLoad, hasBonsaiConsent, setConsentSettings,
    createWorkerBridge, spawnWorker, setWorkerScriptUrl, getWorkerScriptUrl,
    ConsentRequiredError, SurfaceRefusedError, BrowserRequiredError,
    ModelNotFoundError, DeviceLostError, GenerationAbortedError,
  };
  for (const [name, value] of Object.entries(api)) {
    assert.ok(value !== undefined, `export ${name} is undefined`);
  }
});
