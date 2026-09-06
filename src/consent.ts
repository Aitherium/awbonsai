/**
 * The consent gate — the BCG rule set, packaged for strangers.
 *
 * Vendored from `AitherVeil/src/lib/bonsai-consent.ts` (the platform's canonical
 * gate, asserted by `check_bonsai_consent_gate.py`). Two independent questions,
 * and conflating them is how an unasked multi-hundred-MB download keeps coming
 * back:
 *
 *   1. MAY THIS SURFACE run a model at all? (`bonsaiSurfaceRefusal`)
 *      A reading surface may not, ever, for anybody, consented or not. A
 *      per-device "yes" given inside an app must not follow the visitor onto an
 *      article and start a download there.
 *
 *   2. HAS THIS VISITOR agreed? (`readBonsaiConsent`)
 *      Even on an allowed surface, nothing downloads until the visitor says so,
 *      and their answer is remembered only if they tick the box. `granted` is
 *      per-act; `auto` is the standing permission that lets auto-boot fire on
 *      later visits. UNREADABLE STORAGE IS NOT CONSENT: every failure path
 *      returns null, never a default yes.
 *
 * The rules are PURE and take (host, pathname) explicitly rather than reading
 * `location`, so a test can state the reading-surface case directly.
 *
 * The default allowlist is the platform's own — a stranger's site is refused
 * until they configure their surface (`configureAwbonsai({ allowedHosts })` or a
 * `surfaceRule`). Fail-closed is the point: the next host is refused by default
 * instead of being remembered about.
 */

export interface ConsentStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface BonsaiConsent {
  /** The visitor agreed to download and run a model on this device. */
  granted: boolean;
  /** ...and ticked "load automatically from now on". Auto-boot requires THIS, not `granted`. */
  auto: boolean;
  /** ISO timestamp of the answer, so a stale grant is at least visible. */
  at: string;
}

export const DEFAULT_CONSENT_KEY = 'awbonsai-consent';

/**
 * Hosts that may run a model by default. Everything else is refused. This is
 * the platform's own list, vendored as DATA; a consumer's site is refused until
 * they call `configureAwbonsai({ allowedHosts: [...] })` or supply a
 * `surfaceRule` (they are the gate, and they are on record for it).
 *
 * Tenant hosts are deliberately NOT here: they are customers, and a
 * customer's name must not ship in a package strangers install (ADK003).
 * Each tenant adds its own host through configureAwbonsai, which is exactly
 * the consent model this file exists to enforce.
 */
export const DEFAULT_ALLOWED_HOSTS: readonly string[] = [
  'aitherium.com',
  'www.aitherium.com',
  'desktop.aitherium.com',
  'spaces.aitherium.com',
  'localhost',
  '127.0.0.1',
  'elodineofficial.github.io',
  'wizzense.github.io',
];

/**
 * Paths on an ALLOWED host that are still reading surfaces. The apex serves
 * both an app and the blog from one origin, so the host gate alone would let
 * `aitherium.com/blog` through. Prefix-matched on a SEGMENT boundary, so
 * `/blogging-app` is not caught by `/blog`.
 */
export const DEFAULT_DENIED_PATHS: readonly string[] = [
  '/blog',
  '/docs',
  '/media',
  '/changelog',
  '/pricing',
  '/about',
  '/privacy',
  '/terms',
  '/legal',
  '/help',
  '/support',
  '/welcome',
  '/status',
];

export interface ConsentSettings {
  consentKey?: string;
  allowedHosts?: readonly string[];
  deniedPaths?: readonly string[];
  /**
   * A custom surface rule taking over from the allowlist entirely. Returning
   * null means allowed; returning a string refuses WITH that reason. Setting
   * this makes the caller the gate — which is the right shape for a stranger's
   * own site, where the platform's list cannot know their hosts.
   */
  surfaceRule?: ((host: string, pathname: string) => string | null) | null;
  /** Injectable for tests and for apps with their own storage abstraction. */
  storage?: ConsentStorage | null;
}

let settings: Required<Omit<ConsentSettings, 'surfaceRule' | 'storage'>> & {
  surfaceRule: ((host: string, pathname: string) => string | null) | null;
  storage: ConsentStorage | null;
} = {
  consentKey: DEFAULT_CONSENT_KEY,
  allowedHosts: DEFAULT_ALLOWED_HOSTS,
  deniedPaths: DEFAULT_DENIED_PATHS,
  surfaceRule: null,
  storage: null,
};

export function setConsentSettings(partial: ConsentSettings): void {
  if (partial.consentKey !== undefined) settings.consentKey = partial.consentKey;
  if (partial.allowedHosts !== undefined) settings.allowedHosts = partial.allowedHosts;
  if (partial.deniedPaths !== undefined) settings.deniedPaths = partial.deniedPaths;
  if (partial.surfaceRule !== undefined) settings.surfaceRule = partial.surfaceRule;
  if (partial.storage !== undefined) settings.storage = partial.storage;
}

function defaultStorage(): ConsentStorage | null {
  try {
    if (typeof window !== 'undefined' && window.localStorage) return window.localStorage;
  } catch {
    /* storage blocked — fail closed */
  }
  return null;
}

/** Segment-boundary prefix match, so `/blogging-app` is not caught by `/blog`. */
export function matchesPathPrefix(pathname: string, prefix: string): boolean {
  if (pathname === prefix) return true;
  return pathname.startsWith(prefix + '/');
}

/**
 * Why this surface may not run a model — or `null` when it may. Returns a
 * REASON rather than a boolean so the refusal can be surfaced honestly instead
 * of appearing as a button that does nothing.
 */
export function bonsaiSurfaceRefusal(host: string, pathname: string): string | null {
  if (settings.surfaceRule) {
    // The caller owns the gate; their verdict is final.
    return settings.surfaceRule(host, pathname);
  }
  const h = (host || '').toLowerCase().split(':')[0];
  if (!h) return 'The in-browser model is not available on this surface.';
  if (!settings.allowedHosts.includes(h)) {
    return `The in-browser model runs on configured surfaces only — not on ${h}. Add it via configureAwbonsai({ allowedHosts }) if this is an app surface.`;
  }
  const p = pathname || '/';
  const denied = settings.deniedPaths.find((d) => matchesPathPrefix(p, d));
  if (denied) {
    return `The in-browser model does not run on reading surfaces (${denied}).`;
  }
  return null;
}

/** Convenience boolean for call sites that only branch. */
export function isBonsaiSurfaceAllowed(host: string, pathname: string): boolean {
  return bonsaiSurfaceRefusal(host, pathname) === null;
}

/** The current surface, read from `location`. False during SSR — never "allowed by default". */
export function currentSurfaceAllowed(): boolean {
  if (typeof window === 'undefined') return false;
  return isBonsaiSurfaceAllowed(window.location.hostname, window.location.pathname);
}

/** The current surface's refusal reason, or null. */
export function currentSurfaceRefusal(): string | null {
  if (typeof window === 'undefined') return 'The in-browser model is not available here.';
  return bonsaiSurfaceRefusal(window.location.hostname, window.location.pathname);
}

/**
 * The stored answer, or null if never asked.
 *
 * Fails CLOSED on anything unexpected — unreadable storage, malformed JSON, a
 * value written by an older shape. "I could not read the consent" is not consent.
 */
export function readBonsaiConsent(): BonsaiConsent | null {
  const storage = settings.storage ?? defaultStorage();
  if (!storage) return null;
  try {
    const raw = storage.getItem(settings.consentKey);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<BonsaiConsent>;
    if (parsed?.granted !== true) return null;
    return { granted: true, auto: parsed.auto === true, at: String(parsed.at ?? '') };
  } catch {
    return null;
  }
}

/** Has the visitor agreed at all (this device)? */
export function hasBonsaiConsent(): boolean {
  return readBonsaiConsent() !== null;
}

/**
 * May a model boot WITHOUT a tap on this visit? Both gates in one call: the
 * surface must be allowed AND the visitor must have ticked the standing-
 * permission box. A bare `granted` is explicitly not enough — that was a
 * one-time "yes, load it now", and treating it as a standing yes is how a
 * single tap turns into a download on every future page load.
 */
export function bonsaiMayAutoLoad(): boolean {
  if (!currentSurfaceAllowed()) return false;
  return readBonsaiConsent()?.auto === true;
}

/** Record the visitor's answer. `auto` is the checkbox. */
export function grantBonsaiConsent(auto: boolean): BonsaiConsent {
  const consent: BonsaiConsent = { granted: true, auto, at: new Date().toISOString() };
  const storage = settings.storage ?? defaultStorage();
  if (storage) {
    try {
      storage.setItem(settings.consentKey, JSON.stringify(consent));
    } catch {
      /* private mode / storage disabled — the session proceeds, it is just not remembered */
    }
  }
  return consent;
}

/** Withdraw it. Used by settings surfaces and by "stop doing this". */
export function revokeBonsaiConsent(): void {
  const storage = settings.storage ?? defaultStorage();
  if (!storage) return;
  try {
    storage.removeItem(settings.consentKey);
  } catch {
    /* nothing to undo */
  }
}
