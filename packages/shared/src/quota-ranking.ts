/**
 * Ranking helpers for "most-constrained quota" selection, shared by the
 * backend (`QuotaCheckSnapshot`) and frontend (`QuotaStatusEntry`) — both
 * shapes carry the two fields the ratio needs, so the helpers stay generic
 * over them instead of importing either wire type.
 */

/** Minimal shape needed to rank quotas by constraint. */
export interface QuotaRatioFields {
  limit: number;
  remaining: number;
}

/**
 * Remaining-headroom ratio (`remaining / limit`). A `limit <= 0` entry is
 * treated as fully constrained (ratio 0) rather than dividing by zero —
 * `0 / 0` is `NaN`, whose comparisons are always false, which would make a
 * zero-limit quota silently unselectable.
 */
export function constrainedRatio(entry: QuotaRatioFields): number {
  return entry.limit > 0 ? entry.remaining / entry.limit : 0;
}

/** Entry with the smallest remaining/limit ratio (first wins ties); null for
 * an empty list. */
export function mostConstrained<T extends QuotaRatioFields>(entries: T[]): T | null {
  if (entries.length === 0) return null;
  return entries.reduce((min, e) => (constrainedRatio(e) < constrainedRatio(min) ? e : min));
}

/** New array sorted most-constrained (least remaining headroom) first.
 * Does not mutate the input. */
export function sortMostConstrainedFirst<T extends QuotaRatioFields>(entries: T[]): T[] {
  return [...entries].sort((a, b) => constrainedRatio(a) - constrainedRatio(b));
}
