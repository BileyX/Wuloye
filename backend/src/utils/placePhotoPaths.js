/**
 * Builds relative API paths for place photos (auth-required; mobile prepends API base + Bearer).
 *
 * Accepts either positional args or a single options object, since callers
 * across the codebase use both styles:
 *   buildPlacePhotoPaths(id, refs, 400, 5)
 *   buildPlacePhotoPaths(id, refs, { width: 800, max: 4 })
 *
 * @param {string} placeId
 * @param {string[]} photoReferences — Google photo_reference values
 * @param {number|object} [widthOrOptions=400]  — max width (px) or { width, max }
 * @param {number} [maxCount=5]
 * @returns {string[]} e.g. ["/places/ChIJ.../photo?ref=...&w=400"]
 */
export function buildPlacePhotoPaths(
  placeId,
  photoReferences,
  widthOrOptions = 400,
  maxCount = 5,
) {
  if (!placeId || !Array.isArray(photoReferences)) return [];

  let maxWidth = 400;
  let limit    = maxCount;

  if (
    widthOrOptions &&
    typeof widthOrOptions === "object" &&
    !Array.isArray(widthOrOptions)
  ) {
    if (typeof widthOrOptions.width === "number") maxWidth = widthOrOptions.width;
    else if (typeof widthOrOptions.w === "number") maxWidth = widthOrOptions.w;
    if (typeof widthOrOptions.max === "number") limit = widthOrOptions.max;
    else if (typeof widthOrOptions.count === "number") limit = widthOrOptions.count;
  } else if (typeof widthOrOptions === "number") {
    maxWidth = widthOrOptions;
  }

  // Sanity bounds so we never emit garbage `w=` values to Google.
  if (!Number.isFinite(maxWidth) || maxWidth < 64) maxWidth = 400;
  if (!Number.isFinite(limit)    || limit    < 1)  limit    = 5;

  return photoReferences
    .filter(Boolean)
    .slice(0, limit)
    .map(
      (ref) =>
        `/places/${encodeURIComponent(placeId)}/photo?ref=${encodeURIComponent(ref)}&w=${maxWidth}`,
    );
}
