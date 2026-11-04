/**
 * User-facing error text. Paperback shows a thrown error's message in an
 * alert, so every message that can reach the reader says, in plain words, what
 * happened and what to do about it. Technical detail (status lines, headers,
 * cookie state, raw error text) goes to the app log through diag() instead of
 * into the alert, so bug reports still carry it.
 */

/** The one thing a reader can do about comix's "Verify you're human" wall. */
export const SOLVE_SECURITY_CHECK =
    "Tap the cloud button at the top right, finish the \"Verify you're human\" check, then try again.";

export const CHECK_FOR_UPDATE = "Check for an update to the ComixTo extension.";

/** The site changed its data protection; only a new extension build can follow. */
export const CANT_READ_DATA = `Comix changed how it protects its data and this version can't read it. ${CHECK_FOR_UPDATE}`;

/** HTML where JSON was expected: almost always a security check that slipped through. */
export const GOT_WEB_PAGE = `Comix sent a web page instead of data, which usually means a security check. ${SOLVE_SECURITY_CHECK}`;

/** Signing keys rotated and the in-app refresh could not follow. */
export function keysChangedMessage(detail?: string): string {
    return `Comix changed its access keys and this version couldn't pick up the new ones${detail ? ` (${detail})` : ""}. ${CHECK_FOR_UPDATE}`;
}

/** A non-2xx comix status, in the reader's words. */
export function httpErrorMessage(status: number): string {
    if (status === 403) return `Comix refused this request (HTTP 403). ${SOLVE_SECURITY_CHECK} If that doesn't help, check for an update to the ComixTo extension.`;
    if (status === 404) return "Comix couldn't find this title or chapter (HTTP 404). It may have been removed; try searching for it again.";
    if (status === 429) return "Comix is asking you to slow down (HTTP 429). Wait a minute, then try again.";
    if (status >= 500) return `Comix's server had a problem (HTTP ${status}). Wait a moment, then try again.`;
    return `Comix sent an unexpected response (HTTP ${status}). Try again in a moment; if it keeps happening, check for an update to the ComixTo extension.`;
}

/** An error whose message is already written for the reader; never rewrap it. */
export class UserFacingError extends Error {}

/** Log technical detail to Paperback's console without showing it to the reader. */
export function diag(detail: string): void {
    try {
        if (typeof console !== "undefined") console.log(`[ComixTo] ${detail}`);
    } catch {
        // no console in this runtime
    }
}
