/**
 * The engine spawn: fetched cross-origin, hash-checked, started from a Blob,
 * relative URLs resolved against the ORIGINAL script location. Node has no
 * Worker, so the browser globals are faked; the URL/integrity logic is real.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import vm from 'node:vm';

import {
  DEFAULT_WORKER_SCRIPT_URL,
  DEFAULT_WORKER_SCRIPT_SHA256,
  WorkerIntegrityError,
  configureAwbonsai,
  detectScriptType,
  getWorkerScriptSha256,
  getWorkerScriptUrl,
  loadModel,
  normaliseSha256,
  prepareWorkerSource,
  rewriteModuleSpecifiers,
  setWorkerScriptUrl,
  spawnWorker,
  workerPrelude,
} from '../dist/index.js';

const ENGINE = 'var a=1;self.onmessage=function(e){};fetch("/corpus/index.json");';
const bytes = (s) => new TextEncoder().encode(s).buffer;
const sha = (s) => createHash('sha256').update(s).digest('hex');

test('default engine: content-addressed on the weight mirror, name carries the pin', () => {
  assert.match(DEFAULT_WORKER_SCRIPT_URL, /^https:\/\/weights\.aitherium\.com\/awbonsai-engine-[0-9a-f]{12}\.js$/);
  assert.ok(DEFAULT_WORKER_SCRIPT_URL.includes(DEFAULT_WORKER_SCRIPT_SHA256.slice(0, 12)));
  assert.match(DEFAULT_WORKER_SCRIPT_SHA256, /^[0-9a-f]{64}$/);
  // The URL that 404'd (measured 2026-10-01) must never come back as the default.
  assert.notEqual(DEFAULT_WORKER_SCRIPT_URL, 'https://weights.aitherium.com/bonsai-worker.js');
});

test('pin follows the URL: default keeps the release pin, another URL is unpinned unless given', () => {
  try {
    setWorkerScriptUrl('https://example.test/engine.js');
    assert.equal(getWorkerScriptSha256(), null);
    setWorkerScriptUrl('https://example.test/engine.js', 'SHA256-' + 'AB'.repeat(32));
    assert.equal(getWorkerScriptSha256(), 'ab'.repeat(32));
    assert.throws(() => setWorkerScriptUrl('https://example.test/e.js', 'nothex'), /not a sha256/);
    // A refused pin leaves the previous config intact.
    assert.equal(getWorkerScriptUrl(), 'https://example.test/engine.js');
    setWorkerScriptUrl(DEFAULT_WORKER_SCRIPT_URL);
    assert.equal(getWorkerScriptSha256(), DEFAULT_WORKER_SCRIPT_SHA256);
  } finally {
    setWorkerScriptUrl(DEFAULT_WORKER_SCRIPT_URL);
  }
  assert.equal(normaliseSha256(''), null);
});

test('integrity: a mismatch is refused with WorkerIntegrityError naming both hashes', async () => {
  const wrong = 'f'.repeat(64);
  await assert.rejects(
    prepareWorkerSource(bytes(ENGINE), 'https://cdn.test/w/engine.js', { sha256: wrong }),
    (e) => e instanceof WorkerIntegrityError && e.expected === wrong && e.actual === sha(ENGINE)
      && /refusing to start/.test(e.message),
  );
  const ok = await prepareWorkerSource(bytes(ENGINE), 'https://cdn.test/w/engine.js', { sha256: sha(ENGINE) });
  assert.equal(ok.sha256, sha(ENGINE));
  assert.equal(ok.type, 'classic');
  assert.ok(ok.source.endsWith(ENGINE), 'engine bytes are carried unchanged after the prelude');
});

test('type detection: minified classic engine vs ES module entry', () => {
  assert.equal(detectScriptType(ENGINE), 'classic');
  assert.equal(detectScriptType('var x=1;let y=await import("./a.js");'), 'classic');
  assert.equal(detectScriptType('// c\nimport { a } from "./a.js";\na(self);'), 'module');
  assert.equal(detectScriptType('export default 1'), 'module');
  assert.equal(detectScriptType('import "./side.js"'), 'module');
});

test('module specifiers: relative -> absolute against the ORIGINAL script URL; bare + absolute untouched', () => {
  const src = 'import { a } from "./a.js";\nimport b from \'../b.js\';\nimport "/c.js";\n'
    + 'import x from "https://other.test/x.js";\nimport y from "bare";\nconst d = import("./d.js");';
  const out = rewriteModuleSpecifiers(src, 'https://cdn.test/w/v1/entry.js');
  assert.ok(out.includes('"https://cdn.test/w/v1/a.js"'));
  assert.ok(out.includes("'https://cdn.test/w/b.js'"));
  assert.ok(out.includes('"https://cdn.test/c.js"'));
  assert.ok(out.includes('"https://other.test/x.js"'));
  assert.ok(out.includes('"bare"'));
  assert.ok(out.includes('import("https://cdn.test/w/v1/d.js")'));
});

test('prelude: fetch / importScripts / XHR / Worker resolve relative URLs against the script location', () => {
  const seen = { fetch: [], importScripts: [], xhr: [], worker: [] };
  function XHR() {}
  XHR.prototype.open = function (m, u) { seen.xhr.push(u); };
  function W(u) { seen.worker.push(u); }
  const self = {
    fetch: (u) => { seen.fetch.push(u); return Promise.resolve(); },
    importScripts: (...u) => { seen.importScripts.push(...u); },
    XMLHttpRequest: XHR,
    Worker: W,
  };
  const ctx = vm.createContext({ self, URL });
  vm.runInContext(
    workerPrelude('https://cdn.test/w/engine.js') + `
      self.fetch('/corpus/index.json'); self.fetch('k.wasm'); self.fetch('https://abs.test/x');
      self.fetch('data:,x'); self.importScripts('./sub.js', 'https://abs.test/y.js');
      new self.XMLHttpRequest().open('GET', '../m.bin'); new self.Worker('child.js');`,
    ctx,
  );
  assert.deepEqual(seen.fetch, [
    'https://cdn.test/corpus/index.json', 'https://cdn.test/w/k.wasm', 'https://abs.test/x', 'data:,x',
  ]);
  assert.deepEqual(seen.importScripts, ['https://cdn.test/w/sub.js', 'https://abs.test/y.js']);
  assert.deepEqual(seen.xhr, ['https://cdn.test/m.bin']);
  assert.deepEqual(seen.worker, ['https://cdn.test/w/child.js']);
  assert.equal(self.__AWBONSAI_SCRIPT_URL__, 'https://cdn.test/w/engine.js');
});

/** Fake the browser globals spawnWorker needs; returns what it recorded. */
function withBrowser(fn, { body = ENGINE, status = 200 } = {}) {
  const rec = { fetched: [], blobs: [], workers: [], revoked: [] };
  const saved = {
    Worker: globalThis.Worker, fetch: globalThis.fetch, window: globalThis.window,
    create: URL.createObjectURL, revoke: URL.revokeObjectURL,
  };
  globalThis.Worker = class {
    constructor(url, opts) { this.url = url; this.opts = opts; rec.workers.push(this); }
    postMessage() {}
    addEventListener() {}
    terminate() { this.terminated = true; }
  };
  globalThis.fetch = async (url, init) => {
    rec.fetched.push({ url, init });
    return new Response(body, { status });
  };
  URL.createObjectURL = (blob) => { rec.blobs.push(blob); return `blob:test/${rec.blobs.length}`; };
  URL.revokeObjectURL = (u) => { rec.revoked.push(u); };
  const restore = () => {
    globalThis.Worker = saved.Worker; globalThis.fetch = saved.fetch; globalThis.window = saved.window;
    URL.createObjectURL = saved.create; URL.revokeObjectURL = saved.revoke;
  };
  return Promise.resolve().then(() => fn(rec)).finally(restore);
}

test('spawnWorker: fetches with CORS, starts a classic Blob worker, revokes the Blob on terminate', () =>
  withBrowser(async (rec) => {
    const w = await spawnWorker('https://cdn.test/w/engine.js', { sha256: sha(ENGINE) });
    assert.equal(rec.fetched[0].url, 'https://cdn.test/w/engine.js');
    assert.equal(rec.fetched[0].init.mode, 'cors');
    assert.equal(rec.workers[0].url, 'blob:test/1');
    assert.equal(rec.workers[0].opts, undefined, 'classic engine -> classic worker');
    const text = await rec.blobs[0].text();
    assert.ok(text.includes('"https://cdn.test/w/engine.js"') && text.endsWith(ENGINE));
    w.terminate();
    assert.deepEqual(rec.revoked, ['blob:test/1']);
  }));

test('spawnWorker: module entry -> module worker', () =>
  withBrowser(async (rec) => {
    await spawnWorker('https://cdn.test/w/entry.js', { sha256: null });
    assert.deepEqual(rec.workers[0].opts, { type: 'module' });
    assert.ok((await rec.blobs[0].text()).includes('"https://cdn.test/w/a.js"'));
  }, { body: 'import { a } from "./a.js";\na(self);' }));

test('spawnWorker: the DEFAULT engine is checked against the release pin (tampered bytes refused, no Worker)', () =>
  withBrowser(async (rec) => {
    await assert.rejects(spawnWorker(), WorkerIntegrityError);
    assert.equal(rec.fetched[0].url, DEFAULT_WORKER_SCRIPT_URL);
    assert.equal(rec.workers.length, 0);
    assert.equal(rec.blobs.length, 0);
  }));

test('spawnWorker: an HTTP error names the status', () =>
  withBrowser(async () => {
    await assert.rejects(spawnWorker('https://cdn.test/missing.js'), /HTTP 404/);
  }, { status: 404, body: 'nope' }));

test('loadModel: an integrity failure surfaces as WorkerIntegrityError, not BrowserRequiredError', () =>
  withBrowser(async () => {
    globalThis.window = { location: { hostname: 'localhost', pathname: '/' } };
    configureAwbonsai({ surfaceRule: () => null });
    try {
      await assert.rejects(loadModel('bonsai-1.7b', { consent: true }), WorkerIntegrityError);
    } finally {
      configureAwbonsai({ surfaceRule: null });
    }
  }));
