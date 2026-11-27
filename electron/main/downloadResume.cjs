/**
 * Decides where a broken download must continue from.
 *
 * Three things can be true at once and they disagree:
 *   - the record says how many bytes arrived (`receivedBytes`),
 *   - Chromium preallocates the destination file, so its size can already be
 *     the full total while most of it is still a sparse hole,
 *   - and a cancelled download deletes the partial file, leaving a recorded
 *     offset that points past the end of nothing.
 *
 * Resuming from the recorded offset in the last case produced a file that was
 * missing its first megabytes but was reported as complete. The on-disk size is
 * therefore the upper bound: never claim more than what is actually there, and
 * start from zero when the file is gone.
 */
function planResume({ recordedBytes, fileSize, totalBytes } = {}) {
  const recorded = Number(recordedBytes) > 0 ? Math.floor(recordedBytes) : 0;
  const size = Number(fileSize) > 0 ? Math.floor(fileSize) : 0;
  const total = Number(totalBytes) > 0 ? Math.floor(totalBytes) : 0;

  let start = 0;
  if (size > 0) start = recorded > 0 ? Math.min(recorded, size) : size;

  return { start, complete: total > 0 && start > 0 && start >= total };
}

module.exports = { planResume };
