/**
 * awbonsai error classes.
 *
 * Every failure the brick can raise is a named class so a consumer can branch on
 * the KIND of failure rather than parsing a message. The fail-closed contract is:
 * `ConsentRequiredError` and `SurfaceRefusedError` are raised BEFORE any download
 * starts, never after (BCG002: position is the rule).
 */

/** No consent record exists (or storage is unreadable) and the caller did not assert one. */
export class ConsentRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConsentRequiredError';
  }
}

/** The current surface is refused by the surface rule (a reading surface, an unlisted host). */
export class SurfaceRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SurfaceRefusedError';
  }
}

/** The API is being used outside a browser tab (Node, SSR) where no Worker can run. */
export class BrowserRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BrowserRequiredError';
  }
}

/** The model id is not in the catalogue. */
export class ModelNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModelNotFoundError';
  }
}

/**
 * The GPU device was torn away (a TDR display-driver reset on Windows is the
 * overwhelmingly common cause). Never retry automatically: a retry re-arms the
 * same reset — the wire contract marks this `fatal` for exactly that reason.
 */
export class DeviceLostError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DeviceLostError';
  }
}

/** The generation was interrupted, either by the caller (AbortSignal) or by `interrupt()`. */
export class GenerationAbortedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GenerationAbortedError';
  }
}
