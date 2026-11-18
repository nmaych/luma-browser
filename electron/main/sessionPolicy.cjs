/**
 * Per-session policy.
 *
 * Chromium browsers install one ordered request pipeline per profile: user
 * agent and privacy headers first, then the network rules, then downloads.
 * Electron exposes the same hooks but they were previously scattered across
 * `whenReady`, so adding a rule meant touching several places and it was easy to
 * forget the incognito profile.
 *
 * `configureSession` keeps the order explicit and applies it to every profile,
 * including the incognito one, which must never inherit a stateful handler from
 * the regular profile.
 */

const ELECTRON_TOKEN = /\sElectron\/[\d.]+/i;
const LUMA_TOKEN = /\sLuma Browser\/[\d.]+/i;

/**
 * Sites expect a plain Chrome user agent. Both tokens Electron appends must be
 * removed or some sites serve their "unsupported browser" page.
 */
function normalizeUserAgent(value) {
  return String(value ?? '').replace(ELECTRON_TOKEN, '').replace(LUMA_TOKEN, '').trim();
}

/**
 * @param {{ setUserAgent: Function, setPermissionRequestHandler: Function, setPermissionCheckHandler: Function }} target
 * @param {{
 *   onPermissionRequest?: Function,
 *   onPermissionCheck?: Function,
 *   onDownload?: (target: unknown) => void,
 *   onRequest?: (target: unknown) => void,
 * }} hooks
 */
function configureSession(target, hooks = {}) {
  const { onPermissionRequest, onPermissionCheck, onDownload, onRequest } = hooks;

  // 1. Identity: a Chrome UA without Electron/Luma product tokens.
  target.setUserAgent(normalizeUserAgent(target.getUserAgent()));

  // 2. Permission prompts: camera, microphone, geolocation, notifications.
  if (onPermissionRequest) target.setPermissionRequestHandler(onPermissionRequest);
  if (onPermissionCheck) target.setPermissionCheckHandler(onPermissionCheck);

  // 3. Network: ad blocking and download interception run on the same profile,
  //    in that order, so a blocked request never reaches the download handler.
  onRequest?.(target);
  onDownload?.(target);

  return target;
}

module.exports = { configureSession, normalizeUserAgent };
