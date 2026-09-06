# awbonsai

Run a real Bonsai model in the visitor's own browser — **one `npm install`, the
model answers on the tab's own GPU, no account, no upload, no server round trip.**

```bash
npm install @aitherium/awbonsai
```

```ts
import {
  grantBonsaiConsent,
  loadModel,
  isSupported,
} from '@aitherium/awbonsai'

// 1. Honest probe — downloads nothing, asks nothing.
const report = await isSupported()
if (!report.supported) console.log(report.reason)

// 2. Ask the visitor first (your UI, your copy). Consent is the gate:
//    nothing downloads until this exists or you pass { consent: true }.
grantBonsaiConsent(false /* auto */)

// 3. Load and generate.
const model = await loadModel('bonsai-1.7b')
const reply = await model.generate('why is the sky blue?', {
  onToken: (t) => output.textContent += t,
  onThinking: (t) => thinking.textContent += t,
})
```

## What you get

- **`loadModel(modelId, opts?)`** → a session with `generate(prompt, opts)`,
  `interrupt()`, `dispose()`. Streams tokens, thinking, progress, images.
- **`generate(prompt, opts?)`** — one-shot convenience (load + generate + dispose).
- **`isSupported()`** — honest capability detection (WebGPU / WebNN, adapter
  probe, mobile refusal, software-rasteriser detection). A **null adapter hint
  never reads as allowed** — that is the exact trap that shipped once.
- **`BONSAI_MODELS`** — the catalogue with honest metadata: real blob sizes,
  quant (Q1_0 only — the kernels cannot decode the ternary Q2_0 builds, and the
  catalogue does not pretend otherwise), trained context windows, architecture.

| id | params | size | context | arch |
|---|---|---|---|---|
| `bonsai-1.7b` | 1.7B | 236 MB | 32k | qwen3 |
| `bonsai-4b` | 4B | 545 MB | 32k | qwen3 |
| `bonsai-8b` | 8B | 1104 MB | 64k | qwen3 |
| `bonsai-27b-text` | 27B | 3627 MB | 262k | qwen35 |

Sizes are the real blob sizes from the HuggingFace API (measured 2026-07-26).
`pickContext(model)` picks a RAM-tiered KV budget that never exceeds the model's
window; `suggestModelId(gpuHint)` errs small on purpose — an overpowered
suggestion is a ten-minute download that ends in a hung tab.

## The consent gate (BCG rule set)

Two independent questions, enforced before the first byte is fetched:

1. **May this surface run a model at all?** A reading surface (blog, docs,
   pricing) may not — ever — for anybody, consented or not. A per-device "yes"
   given inside an app must not follow the visitor onto an article and start a
   multi-hundred-MB download there.
2. **Has this visitor agreed?** Even on an allowed surface, nothing downloads
   until the visitor says so. `granted` is per-act; `auto` is the standing
   permission that lets auto-boot fire on later visits. **Unreadable storage is
   not consent. Unset is off.**

The default surface rule is the platform's own host allowlist (the aitherium.com
family + localhost), so **a stranger's site is refused until configured**. To
adopt the brick on your own domain:

```ts
import { configureAwbonsai } from '@aitherium/awbonsai'

configureAwbonsai({
  allowedHosts: ['my.app', 'localhost'], // your surface is your decision — on record
  // or take the whole rule: surfaceRule: (host, path) => null
  // and the weights host (default is the measured-working mirror):
  mirrorBase: 'https://weights.example.com',
})
```

Refusals return a REASON (a string), not a silent no — a button that does
nothing is how "it just doesn't even try" ships.

## How the engine loads

This package is the **API contract + catalogue + loader**. It does not vendor
llama.cpp, the WGSL kernels, the tokenizer or the GGUF decoder. At runtime the
loader spawns a **worker script fetched from the weight mirror**
(`https://weights.aitherium.com/bonsai-worker.js` by default), which speaks the
wire protocol this package types (`load | generate | interrupt` →
`progress | ready | token | tool_action | image | done | error`). The worker
fetches the model's GGUF (236 MB–3.6 GB, Range + CORS, mirror-first) and runs it
on the tab's GPU.

Override points:

```ts
configureAwbonsai({
  workerScriptUrl: '/my-own-bundled-engine.js', // self-host the engine
  mirrorBase: 'none',                            // genuinely disable the mirror
})
```

`mirrorUrls(model)` returns `[primary, mirror]` and `resolveBonsaiUrl(id)` is
mirror-first: browsers download from the host we control, because the upstream
has gated browsers before — a stall, not an error, which is worse.

## The rules this encodes

The platform's in-browser lane cost real incidents to learn these; they are
vendored here as code, not prose:

- **Mobile is refused the WebGPU lane, tap or no tap.** A mobile browser
  reclaims a background tab's memory and kills the worker holding the weights —
  and a killed worker posts nothing, so the tab crashes with no error. The WASM
  CPU lane is the mobile path.
- **A software rasteriser is not a GPU.** It reports a routinely empty vendor
  string, so it is checked FIRST — an empty vendor would otherwise take the fast
  path. Measured: 0.33 tok/s on the fallback vs 41 tok/s on a real GPU.
- **iPadOS 13+ sends a desktop Safari UA.** The `Macintosh` + touch check
  catches it; a plain UA regex misses every modern iPad.
- **`device-lost` is never retried automatically.** On Windows it almost always
  means a TDR display-driver reset; retrying re-arms the identical reset and the
  visitor's screen flashes (incident 2026-07-31). The bridge latches it.
- **A 4B model once broke a laptop** (Iris Xe, display driver TDR loop that
  outlived the tab). The integrated-GPU ceiling is the 1.7B; the visitor may
  still choose anything above it, deliberately.

## API map

| export | from |
|---|---|
| `loadModel`, `generate`, `configureAwbonsai`, `BonsaiSession` | `@aitherium/awbonsai` |
| `BONSAI_MODELS`, `getBonsaiModel`, `resolveBonsaiUrl`, `mirrorUrls`, `suggestModelId`, `pickContext`, `gpuSizeCeilingMb`, `describeAdapter`, `setMirrorBase` | `@aitherium/awbonsai/models` |
| `createWorkerBridge`, `spawnWorker`, `setWorkerScriptUrl`, `WorkerRequest`, `WorkerResponse`, `ChatMessage` | `@aitherium/awbonsai/worker-core` |
| `isSupported`, `assessSupport`, `classifyAdapter`, `isMobileDevice`, `autoBootAllowed`, `gpuLaneAllowed` | `@aitherium/awbonsai/is-supported` |
| `grantBonsaiConsent`, `revokeBonsaiConsent`, `readBonsaiConsent`, `bonsaiMayAutoLoad`, `bonsaiSurfaceRefusal` | `@aitherium/awbonsai/consent` |

Errors are named classes: `ConsentRequiredError`, `SurfaceRefusedError`,
`BrowserRequiredError`, `ModelNotFoundError`, `DeviceLostError`,
`GenerationAbortedError`.

## Browser support

WebGPU: Chrome/Edge 113+, Firefox 141+, Safari 26+. WebNN where the browser
exposes it. The WebGPU lane is refused on mobile by design; `isSupported()`
tells you exactly why a given device is refused, in `report.reason`.

## License

MIT. The model weights and engine script are loaded at runtime from the hosts
above; the catalogue data (sizes, context windows) is measured metadata.
