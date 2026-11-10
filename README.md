# awbonsai

<!-- aither-header:start GENERATED from the ecosystem registry. Edits here are overwritten; change the registry instead. -->

**[Docs](https://aitherium.github.io/awbonsai/)**  ·  [Source](https://github.com/Aitherium/awbonsai)  ·  `git clone https://github.com/Aitherium/awbonsai`  ·  [The Aither World](https://aitherium.github.io/)

> **The Aither World** is an operating system for agents — a Linux you can hand to one, the runtimes it works in, and the tools it works with. [awnix](https://github.com/Aitherium/awnix) is the Linux underneath it; **awbonsai** is one of its 71 bricks — each installs on its own, runs offline, and needs no account. 6 more are in development and 15 are planned.
>
> **Start here:** Load one page and get an answer from a model that never left the tab.

<!-- aither-header:end -->

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
loader fetches the **engine worker script from the weight mirror**
(`https://weights.aitherium.com/awbonsai-engine-<sha12>.js` — content-addressed,
pinned per awbonsai release by `DEFAULT_WORKER_SCRIPT_SHA256`), which speaks the
wire protocol this package types (`load | generate | interrupt` →
`progress | ready | token | tool_action | image | done | error`). The worker
fetches the model's GGUF (236 MB–3.6 GB, Range + CORS, mirror-first) and runs it
on the tab's GPU.

The engine is on another origin than your page, and `new Worker(url)` is
same-origin only, so the loader **fetches the script (CORS), checks its sha256,
and starts it from a Blob URL**. A hash mismatch is refused with
`WorkerIntegrityError` and nothing runs. Relative URLs the engine resolves
(`fetch`, `importScripts`, XHR, sub-`Worker`) resolve against the script's real
location, not `blob:`. Classic and module scripts are both handled (auto-detected).
If your page sets a CSP, it must allow `worker-src blob:` and `connect-src
https://weights.aitherium.com`.

Override points:

```ts
configureAwbonsai({
  workerScriptUrl: '/my-own-bundled-engine.js', // self-host the engine
  workerScriptSha256: '<64 hex>',                // pin it (omit = unpinned)
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
| `createWorkerBridge`, `spawnWorker` (async), `setWorkerScriptUrl`, `DEFAULT_WORKER_SCRIPT_URL`, `DEFAULT_WORKER_SCRIPT_SHA256`, `prepareWorkerSource`, `WorkerRequest`, `WorkerResponse`, `ChatMessage` | `@aitherium/awbonsai/worker-core` |
| `isSupported`, `assessSupport`, `classifyAdapter`, `isMobileDevice`, `autoBootAllowed`, `gpuLaneAllowed` | `@aitherium/awbonsai/is-supported` |
| `grantBonsaiConsent`, `revokeBonsaiConsent`, `readBonsaiConsent`, `bonsaiMayAutoLoad`, `bonsaiSurfaceRefusal` | `@aitherium/awbonsai/consent` |

Errors are named classes: `ConsentRequiredError`, `SurfaceRefusedError`,
`BrowserRequiredError`, `ModelNotFoundError`, `DeviceLostError`,
`GenerationAbortedError`, `WorkerIntegrityError`.

## Browser support

WebGPU: Chrome/Edge 113+, Firefox 141+, Safari 26+. WebNN where the browser
exposes it. The WebGPU lane is refused on mobile by design; `isSupported()`
tells you exactly why a given device is refused, in `report.reason`.

## License

MIT. The model weights and engine script are loaded at runtime from the hosts
above; the catalogue data (sizes, context windows) is measured metadata.

<!-- aither-ecosystem:start GENERATED from the ecosystem registry. Edits here are overwritten; change the registry instead. -->

## The aw family

Standalone tools that share one idea: **replace something you would otherwise have to _trust_ with something you can _check_.**

Each installs on its own, works offline, and needs no account.

| | instead of trusting | you check |
|---|---|---|
| [awdk](https://github.com/Aitherium/awdk) | a framework's idea of how your agents should run | one loop you can read, pointed at a backend you already pay for |
| [awskills](https://github.com/Aitherium/awskills) | that an agent knows your procedure | the procedure written down, versioned, and loadable by any agent |
| [awpack](https://github.com/Aitherium/awpack) | that the pack you want shipped inside somebody's SDK, under whatever licence that SDK happens to carry | the pack as its own versioned artifact, with its own licence, that any agent runtime can install |
| [awm](https://github.com/Aitherium/awm) | that memory stayed in its lane | tenant:user:project scopes, so a write cannot cross a boundary |
| [awdesk](https://github.com/Aitherium/awdesk) | that the agent is somewhere behind a browser tab | a tray icon, a face on your desktop, and the decision card that pops when it needs you |
| [awnode](https://github.com/Aitherium/awnode) | a vendor's cloud with every prompt | a local gateway routing to backends you chose |
| [awgraph](https://github.com/Aitherium/awgraph) | that grep found everything | an AST + tree-sitter call graph an agent can traverse |
| [awgit](https://github.com/Aitherium/awgit) | that no one else is editing this file | a lease, refused at commit time if you do not hold it |
| [awdelphi](https://github.com/Aitherium/awdelphi) | one agent's confident take on a decision | the round trace, the anonymity, and who dissents |
| [awclassify](https://github.com/Aitherium/awclassify) | a filename, a folder, or whoever last touched it | doc_type, visibility, audience and topics, with the evidence lines that decided each |
| [awdecide](https://github.com/Aitherium/awdecide) | a hosted classifier's probability that never learns whether it was right | the decision, its probability, and the calibration curve from your own resolved outcomes |
| [awtoll](https://github.com/Aitherium/awtoll) | that your tooling is saving you context | the measured token cost of each tool call, and what the alternative cost |
| [awseal](https://github.com/Aitherium/awseal) | that the artifact came from who you think | an Ed25519 seal — the key that verifies is not the key that forges |
| [awshare](https://github.com/Aitherium/awshare) | that the download is intact | content-addressed bundles, verified on fetch |
| [awsuite](https://github.com/Aitherium/awsuite) | that an agent holding your mailbox will not send on its own | every send, draft, upload and create returns a dry-run until confirm is true |
| [awpermit](https://github.com/Aitherium/awpermit) | that an admitted agent will only do what its owner meant | an Ed25519 permit naming the agent, the principal, the door, the actions and the cap |
| [awnest](https://github.com/Aitherium/awnest) | that there is a person on the other end | a verdict with evidence, where "we could not tell" is not "yes" |
| [awrena](https://github.com/Aitherium/awrena) | a leaderboard someone can edit, and votes nobody counted | a scored duel with both answers kept, and a result bound to them |
| [awnboard](https://github.com/Aitherium/awnboard) | a share link anyone who sees it can use | an invitation addressed to one person, for one gate, revocable |
| [awnix](https://github.com/Aitherium/awnix) | that the box is what you left it as | an immutable image you built, with atomic rollback |
| [awrecover](https://github.com/Aitherium/awrecover) | that the restore worked | a restore that fully lands or does not land at all |
| [awstorage](https://github.com/Aitherium/awstorage) | a du you ran last month, and a peers file that says 3 TB free | an inventory snapshot per node with a diff since the last one, and each tree classified re-fetchable or not |
| [awrelay](https://github.com/Aitherium/awrelay) | a SaaS in the middle of your agents | findings, alerts and coordination over your own transport |
| [awask](https://github.com/Aitherium/awask) | that anyone read the paragraph where you asked | the ask itself, with a button that steers the session that raised it |
| [awmail](https://github.com/Aitherium/awmail) | a mailbox somebody else can read | mail your agents send and receive over your own server |
| [awdiscord](https://github.com/Aitherium/awdiscord) | a self-bot on someone's account, or a bot that acts without asking | slash commands, rate limits, and approval buttons only your operators can press |
| [awswarm](https://github.com/Aitherium/awswarm) | that a model either fits your GPU or it doesn't run at all | a placement plan and an acquisition-probability estimate before you spend on a run |
| [awfind](https://github.com/Aitherium/awfind) | one vendor's idea of the web | results from whichever providers you configured |
| [awbrowse](https://github.com/Aitherium/awbrowse) | that the page said what you were told | the render, the DOM and the requests it made |
| [awvoice](https://github.com/Aitherium/awvoice) | that a cloud vendor may hold your audio | a transcript and a wav from a service you host |
| [awvision](https://github.com/Aitherium/awvision) | a filename and a caption somebody wrote | what a model actually reports about the pixels |
| [awscreen](https://github.com/Aitherium/awscreen) | a selector that was true when the page was written | the elements actually rendered, by what they look like |
| [awbeads](https://github.com/Aitherium/awbeads) | that a layout your users built survives the next deploy | the arrangement as data you can read back, diff, and hand to another surface |
| [awsprite](https://github.com/Aitherium/awsprite) | a chatbot with a face that resets every session | a knowledge base you can list, edit, and watch shape what it becomes |
| **awbonsai** _(you are here)_ | that inference always means a request left the machine | a WebGPU model answering on the tab's own GPU, with a consent record logged before it ever loaded |
| [gawbbonet](https://github.com/Aitherium/gawbbonet) | the model to keep a 300-message campaign coherent by itself | campaign facts recalled from scoped memory you can list and edit |
| [aitherkvcache](https://github.com/Aitherium/aitherkvcache) | a vendor's quantisation defaults | sub-byte KV cache kernels you can benchmark yourself |
| [awrtifact](https://github.com/Aitherium/awrtifact) | a hand-rolled split script and a hand-edited worker manifest | byte-verified parts in a release, served with Range + CORS, sizes asserted by a live gate |
| [AitherZero](https://github.com/Aitherium/AitherZero) | a pile of scripts nobody has numbered | numbered, discoverable automation with declarative playbooks |
| [AitherConnect](https://github.com/Aitherium/AitherConnect) | what a page tells your browser to do | a federated search and desktop bridge you host |
| [awreason](https://github.com/Aitherium/awreason) | a confident paragraph | the phases it went through, and every tool call it made to get there |
| [awrecurse](https://github.com/Aitherium/awrecurse) | that everything you pasted in was actually read | which slices it opened, and what it concluded from each |
| [awprism](https://github.com/Aitherium/awprism) | the first explanation that fits | the ranked alternatives, and the observation that separates them |
| [awrepl](https://github.com/Aitherium/awrepl) | what the agent believes the value is | the value, printed from the live session |
| [awreport](https://github.com/Aitherium/awreport) | that the report you pasted carried no token in it | a redacted report, and the duplicate it merged into instead of filing twice |
| [awresearch](https://github.com/Aitherium/awresearch) | a summary of pages nobody opened | every claim against the source it came from |
| [awfocus](https://github.com/Aitherium/awfocus) | twelve terminal tabs and a bad memory | one command that names every session, finds any transcript, and opens or steers the one you want |
| [awgym](https://github.com/Aitherium/awgym) | that a world model learned anything from the games it saw | transitions captured from real play, fed back, and the retrodiction score falling on grids it never saw |
| [awpredict](https://github.com/Aitherium/awpredict) | a model because it trained without erroring | its prediction against a self-updating lookup, on the rows that are actually novel |
| [awevolve](https://github.com/Aitherium/awevolve) | that your optimisation loop is finding anything | every version it kept, the score that version earned, and the edit that produced it |
| [awsh](https://github.com/Aitherium/awsh) | that you already know the name of the command | what it decided your line meant, before it acts on it |
| [awmine](https://github.com/Aitherium/awmine) | that a session's lesson survived the session | a row per outcome, a candidate per lesson, and the transcript line each one came from |
| [awrise](https://github.com/Aitherium/awrise) | that a scheduled agent ran at all, and ran exactly once | a durable record of every wake -- fired, skipped, overlapped or timed out -- each with its reason |
| [awkno](https://github.com/Aitherium/awkno) | that the docs site is up, or that you remember the family | the whole ecosystem in your terminal, with no network at all |
| [awwall](https://github.com/Aitherium/awwall) | that a service only talks to the hosts you think it talks to | an explicit egress allowlist, where a denial names the rule that denied it |
| [awembed](https://github.com/Aitherium/awembed) | a general-purpose embedder that has never seen your code | a held-out split of whole directories, scored teacher vs student vs int8 |
| [awtax](https://github.com/Aitherium/awtax) | a closed tax app's sealed file you can never read again | a plain, provider-neutral schema of every figure, with the page it came from |
| [awsettings](https://github.com/Aitherium/awsettings) | that you will remember to re-approve the same thing on every box you work from | one profile, unioned rather than overwritten, with the credentials left behind |
| [awavatar](https://github.com/Aitherium/awavatar) | a cloud 3D vendor's opaque task id | a manifest with a sha256, a licence and a rig-audit verdict per file |

[**awnix**](https://github.com/Aitherium/awnix) is the ground floor — A Linux you can hand to an agent — immutable base, capabilities included.

## The Aitherium ecosystem

Every repository here is public. Each publishes an `aither-manifest.json` beside its page, so any surface can read every sibling's — the network is browsable from any node in it.

| repo | what it is | pages |
|---|---|---|
| [awdk](https://github.com/Aitherium/awdk) | Build AI agent fleets — 3 lines, any backend, local or cloud | [docs](https://aitherium.github.io/awdk/) |
| [awskills](https://github.com/Aitherium/awskills) | Portable agent skills — self-contained procedures an agent loads on demand | [docs](https://aitherium.github.io/awskills/) |
| [awpack](https://github.com/Aitherium/awpack) | First-party agent packs — the ones we build, versioned and installable on their own | [docs](https://aitherium.github.io/awpack/) |
| [awm](https://github.com/Aitherium/awm) | A portable, scoped agent memory | [docs](https://aitherium.github.io/awm/) |
| [awdesk](https://github.com/Aitherium/awdesk) | Aither World Desk -- the desktop body of AitherOS Online: tray, avatars, decision cards, the Living Desktop as an overlay | [docs](https://aitherium.github.io/awdesk/) |
| [awnode](https://github.com/Aitherium/awnode) | A lightweight local gateway — bridges your apps to the AI backends you chose | [docs](https://aitherium.github.io/awnode/) |
| [awrun](https://github.com/Aitherium/awrun) | A priority-aware queue and dispatcher for agentic runs and ad-hoc CI builds. It also judges whether the runner pool is big enough for the queue it is draining, and can ask a host to grow it -- reserving capacity is zero-sum, so a saturated pool needs more of it, not a different share of it | [docs](https://aitherium.github.io/awrun/) |
| [awpool](https://github.com/Aitherium/awpool) | The free half of the elastic work pool: dispatches public-safe work onto the free GitHub-hosted runners of the public aw* mirrors, so their idle CI minutes become compute. awrun remains the paid/self-hosted lane; this is its free twin | [docs](https://aitherium.github.io/awpool/) |
| [awgraph](https://github.com/Aitherium/awgraph) | A semantic code graph for agents — AST + tree-sitter, call graphs | [docs](https://aitherium.github.io/awgraph/) |
| [awgit](https://github.com/Aitherium/awgit) | Semantic version control on top of git — edit-ops and leases | [docs](https://aitherium.github.io/awgit/) |
| [awdelphi](https://github.com/Aitherium/awdelphi) | Anonymous multi-round expert panels — a converged answer with a trace | [docs](https://aitherium.github.io/awdelphi/) |
| [awclassify](https://github.com/Aitherium/awclassify) | Classify any document -- what it is, who may read it, who it is for, what it is about | [docs](https://aitherium.github.io/awclassify/) |
| [awdecide](https://github.com/Aitherium/awdecide) | One typed-decision contract -- choice / score / bool with a probability -- over a ladder of backends you already run (rules, tiny local models, an LLM's logprobs), fail-closed, with a Brier ledger that resolves every decision against its outcome | [docs](https://aitherium.github.io/awdecide/) |
| [awtoll](https://github.com/Aitherium/awtoll) | What every tool call costs you in context, measured from your own transcripts | [docs](https://aitherium.github.io/awtoll/) |
| [awseal](https://github.com/Aitherium/awseal) | Sign an artifact so a stranger can verify it | [docs](https://aitherium.github.io/awseal/) |
| [awshare](https://github.com/Aitherium/awshare) | Publish an artifact and fetch it back verified | [docs](https://aitherium.github.io/awshare/) |
| [awsuite](https://github.com/Aitherium/awsuite) | Your Google Workspace as agent tools, and no write happens without a yes | [docs](https://aitherium.github.io/awsuite/) |
| [awdit](https://github.com/Aitherium/awdit) | An append-only audit trail whose gaps are DETECTABLE | [docs](https://aitherium.github.io/awdit/) |
| [awbac](https://github.com/Aitherium/awbac) | Role-based access control that fails closed and explains itself | [docs](https://aitherium.github.io/awbac/) |
| [awiam](https://github.com/Aitherium/awiam) | Who is this caller? A directory and session store that fails honestly | [docs](https://aitherium.github.io/awiam/) |
| [awtunnel](https://github.com/Aitherium/awtunnel) | Reach a service that has no public address | [docs](https://aitherium.github.io/awtunnel/) |
| [awpermit](https://github.com/Aitherium/awpermit) | Let an agent through your door with a scope, a spend cap, and someone accountable | [docs](https://aitherium.github.io/awpermit/) |
| [awnest](https://github.com/Aitherium/awnest) | Prove there is a human before you let them into the nest | [docs](https://aitherium.github.io/awnest/) |
| [awrena](https://github.com/Aitherium/awrena) | Put two agents head to head and get a verdict you can check | [docs](https://aitherium.github.io/awrena/) |
| [awnboard](https://github.com/Aitherium/awnboard) | A front gate you can put in front of anything, and hand someone the key to | [docs](https://aitherium.github.io/awnboard/) |
| [awnix](https://github.com/Aitherium/awnix) | A Linux you can hand to an agent — immutable base, capabilities included | [docs](https://aitherium.github.io/awnix/) |
| [awrecover](https://github.com/Aitherium/awrecover) | Labelled snapshots with an all-or-nothing restore | [docs](https://aitherium.github.io/awrecover/) |
| [awstorage](https://github.com/Aitherium/awstorage) | Every drive on every node, indexed, classified and diffed -- so you can see what you own before you delete it | [docs](https://aitherium.github.io/awstorage/) |
| [awrelay](https://github.com/Aitherium/awrelay) | Portable agent messaging — findings, alerts, coordination | [docs](https://aitherium.github.io/awrelay/) |
| [awask](https://github.com/Aitherium/awask) | Your agent asks you a question — and acts on your answer | [docs](https://aitherium.github.io/awask/) |
| [awmail](https://github.com/Aitherium/awmail) | Give an agent an email address — send, and actually receive | [docs](https://aitherium.github.io/awmail/) |
| [awdiscord](https://github.com/Aitherium/awdiscord) | Put any agent on Discord as a real bot, with an operator in the loop | [docs](https://aitherium.github.io/awdiscord/) |
| [awnet](https://github.com/Aitherium/awnet) | The agentic web — agents host a mesh, and agents join one | [docs](https://aitherium.github.io/awnet/) |
| [awswarm](https://github.com/Aitherium/awswarm) | Run one model too big for any single GPU across a pool of small ones | [docs](https://aitherium.github.io/awswarm/) |
| [awfind](https://github.com/Aitherium/awfind) | A portable search client — query, results, ranking | [docs](https://aitherium.github.io/awfind/) |
| [awbrowse](https://github.com/Aitherium/awbrowse) | A portable browser client — navigate, console, network, DOM, screenshot | [docs](https://aitherium.github.io/awbrowse/) |
| [awvoice](https://github.com/Aitherium/awvoice) | Hear and speak — transcribe audio, synthesize a voice | [docs](https://aitherium.github.io/awvoice/) |
| [awvision](https://github.com/Aitherium/awvision) | See an image — describe it, ask it a question, compare two | [docs](https://aitherium.github.io/awvision/) |
| [awscreen](https://github.com/Aitherium/awscreen) | See this machine — what is on screen, and where to click it | [docs](https://aitherium.github.io/awscreen/) |
| [awkit](https://github.com/Aitherium/awkit) | Render an agent panel from a tool result — one component, any React app | [docs](https://aitherium.github.io/awkit/) |
| [awbeads](https://github.com/Aitherium/awbeads) | A spatial canvas for a page — arrange things, connect them, and keep the arrangement | [docs](https://aitherium.github.io/awbeads/) |
| [awsprite](https://github.com/Aitherium/awsprite) | Hatch a companion that grows only from what you teach it, then take it home | [docs](https://aitherium.github.io/awsprite/) |
| **awbonsai** _(you are here)_ | Run a real model in the visitor's own browser — no server round trip, no upload | [docs](https://aitherium.github.io/awbonsai/) |
| [awknowledge](https://github.com/Aitherium/awknowledge) | How to run a coding agent so the result survives — the laws, with evidence | [docs](https://aitherium.github.io/awknowledge/) |
| [awbrain](https://github.com/Aitherium/awbrain) | Your history as a wiki of linked markdown — claims pinned to the evidence | [docs](https://aitherium.github.io/awbrain/) |
| [gawbbonet](https://github.com/Aitherium/gawbbonet) | GobboNet campaigns with a real agent brain — scoped memory, graph recall | [docs](https://aitherium.github.io/gawbbonet/) |
| [aitherkvcache](https://github.com/Aitherium/aitherkvcache) | Near-optimal KV cache quantization for LLM inference — sub-byte compression | [docs](https://aitherium.github.io/aitherkvcache/) |
| [awrtifact](https://github.com/Aitherium/awrtifact) | Deliberately chunk artifacts into GitHub release assets — the productized aitherkvcache mirror lane | [docs](https://aitherium.github.io/awrtifact/) |
| [AitherZero](https://github.com/Aitherium/AitherZero) | PowerShell 7+ automation framework — numbered, self-describing scripts | [docs](https://aitherium.github.io/AitherZero/) |
| [AitherConnect](https://github.com/Aitherium/AitherConnect) | Browser extension — federated AI search, page context, and the Living OS overlay | [docs](https://aitherium.github.io/AitherConnect/) |
| [awreason](https://github.com/Aitherium/awreason) | A portable reasoning client — sessions, phases, thoughts, and the chain that produced the answer | [docs](https://aitherium.github.io/awreason/) |
| [awrecurse](https://github.com/Aitherium/awrecurse) | Answer a question over a context far larger than the window — recursively, with the trace kept | [docs](https://aitherium.github.io/awrecurse/) |
| [awprism](https://github.com/Aitherium/awprism) | Turn a failure into ranked hypotheses — and say what would confirm each one | [docs](https://aitherium.github.io/awprism/) |
| [awrepl](https://github.com/Aitherium/awrepl) | A REPL an agent can actually use — state that survives between turns | [docs](https://aitherium.github.io/awrepl/) |
| [awreport](https://github.com/Aitherium/awreport) | File a bug report that has already scrubbed your secrets and collapsed the duplicate | [docs](https://aitherium.github.io/awreport/) |
| [awresearch](https://github.com/Aitherium/awresearch) | Ask a research question, get a cited report you can check | [docs](https://aitherium.github.io/awresearch/) |
| [awfocus](https://github.com/Aitherium/awfocus) | See, search and steer every Claude session from one command | [docs](https://aitherium.github.io/awfocus/) |
| [awgym](https://github.com/Aitherium/awgym) | An ARC training gym — a game a world model can watch, and six roles that play through it | [docs](https://aitherium.github.io/awgym/) |
| [awpredict](https://github.com/Aitherium/awpredict) | Predict what your environment does next, and how surprised you were | [docs](https://aitherium.github.io/awpredict/) |
| [awevolve](https://github.com/Aitherium/awevolve) | Point an agent at a file and a command that scores it, and let it improve | [docs](https://aitherium.github.io/awevolve/) |
| [awsh](https://github.com/Aitherium/awsh) | Your terminal answers you -- type a question where a command would go | [docs](https://aitherium.github.io/awsh/) |
| [awmine](https://github.com/Aitherium/awmine) | Mine what your agents did -- outcomes, lessons and procedures out of the transcripts they left behind | [docs](https://aitherium.github.io/awmine/) |
| [awrise](https://github.com/Aitherium/awrise) | Wake an agent on a schedule, let it do one thing, and put it back to sleep | [docs](https://aitherium.github.io/awrise/) |
| [awkno](https://github.com/Aitherium/awkno) | The man page for the Aither World — every brick, stack and law, offline | [docs](https://aitherium.github.io/awkno/) |
| [awwall](https://github.com/Aitherium/awwall) | Say what a workload may reach, and watch everything else fail closed | [docs](https://aitherium.github.io/awwall/) |
| [awrouter](https://github.com/Aitherium/awrouter) | OpenRouter for your own fleet: pick a model backend by cost/latency/ capability, fail over, fit the context window, stream. Standalone, OpenAI-compatible, no Aither-specifics required to be valuable | [docs](https://aitherium.github.io/awrouter/) |
| [awembed](https://github.com/Aitherium/awembed) | Train an embedding model that knows your corpus, and prove it beats the big one | [docs](https://aitherium.github.io/awembed/) |
| [awtax](https://github.com/Aitherium/awtax) | Turn any tax PDF -- returns, W-2, 1099, statements, even scans -- into structured data you can check | [docs](https://aitherium.github.io/awtax/) |
| [awflow](https://github.com/Aitherium/awflow) | A deterministic workflow runtime — chain agent calls with journal replay and budget control | [docs](https://aitherium.github.io/awflow/) |
| [awsettings](https://github.com/Aitherium/awsettings) | Your agent's permissions and config, following you to the next machine | [docs](https://aitherium.github.io/awsettings/) |
| [awavatar](https://github.com/Aitherium/awavatar) | One character spec in, a rigged, animated, multi-style avatar pack out | [docs](https://aitherium.github.io/awavatar/) |

**Built on** [REA (Reverse Engineer Anything)](https://github.com/morluto/rea) · [llama.cpp](https://github.com/ggml-org/llama.cpp) · [vLLM](https://github.com/vllm-project/vllm) · [ComfyUI](https://github.com/comfyanonymous/ComfyUI) · [CentOS Stream](https://www.centos.org/centos-stream/) · [Podman](https://github.com/containers/podman) · [Docker](https://github.com/moby/moby) · [LanceDB](https://github.com/lancedb/lancedb) · [WireGuard](https://www.wireguard.com/) · [FFmpeg](https://ffmpeg.org/) · [Blender + Rigify](https://www.blender.org/) · [headroom](https://github.com/headroomlabs-ai/headroom) · [SANA](https://github.com/NVlabs/Sana) · [Hunyuan3D](https://github.com/Tencent-Hunyuan/Hunyuan3D-2.1) · [repowise](https://github.com/repowise-dev/repowise) · [Playwright](https://github.com/microsoft/playwright) · [Chromium](https://www.chromium.org/) · [Next.js](https://github.com/vercel/next.js) · [React](https://github.com/facebook/react).

<div id="aither-constellation" data-self="awbonsai"></div>
<script src="aither-constellation.js"></script>

<!-- aither-ecosystem:end -->
