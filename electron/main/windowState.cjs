const fs = require('node:fs');
const { screen } = require('electron');

/**
 * Window geometry persistence.
 *
 * The renderer only ever sends rectangles; validation and "is this rectangle
 * still on a display that exists" checks live here, which is also what browsers
 * do before restoring a saved window onto a monitor that was unplugged.
 */

function readWindowState(filePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return null;
    const bounds = parsed.bounds;
    if (
      !bounds ||
      !Number.isFinite(bounds.width) ||
      !Number.isFinite(bounds.height) ||
      !Number.isFinite(bounds.x) ||
      !Number.isFinite(bounds.y)
    ) {
      return null;
    }
    return { bounds, maximized: parsed.maximized === true };
  } catch {
    return null;
  }
}

function writeWindowState(filePath, bounds, maximized) {
  try {
    fs.writeFileSync(filePath, JSON.stringify({ bounds, maximized }), 'utf8');
  } catch {
    // A read-only profile must not break window controls.
  }
}

/** Accepts {screenX,screenY} or {x,y} and returns both spellings. */
function normalizeScreenPoint(value) {
  if (!value || typeof value !== 'object') return null;
  const x = Number(value.screenX ?? value.x);
  const y = Number(value.screenY ?? value.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x, y, screenX: x, screenY: y };
}

function normalizeExternalBounds(value) {
  if (!value || typeof value !== 'object') return null;
  const x = Math.round(Number(value.x));
  const y = Math.round(Number(value.y));
  const width = Math.round(Number(value.width));
  const height = Math.round(Number(value.height));
  if (![x, y, width, height].every(Number.isFinite)) return null;
  return {
    x,
    y,
    width: Math.max(380, Math.min(4000, width)),
    height: Math.max(500, Math.min(4000, height)),
  };
}

/**
 * Clamps a saved rectangle to the minimum window size and rejects rectangles
 * that no longer touch a display, so a window is never restored off-screen.
 */
function normalizeWindowBounds(bounds, limits) {
  if (!bounds) return null;
  const width = Math.max(limits.minWidth, Math.round(bounds.width));
  const height = Math.max(limits.minHeight, Math.round(bounds.height));
  const x = Math.round(bounds.x);
  const y = Math.round(bounds.y);
  const visible = screen.getAllDisplays().some((display) => {
    const area = display.workArea;
    return (
      x < area.x + area.width - 80 &&
      x + width > area.x + 80 &&
      y < area.y + area.height - 40 &&
      y + height > area.y + 40
    );
  });
  return visible ? { x, y, width, height } : null;
}

module.exports = {
  normalizeExternalBounds,
  normalizeScreenPoint,
  normalizeWindowBounds,
  readWindowState,
  writeWindowState,
};
