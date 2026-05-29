/**
 * Pure formatting for the live activity-row suffix.
 *
 * Thresholds keep the row calm: a sub-2s overall time and a sub-3s step time
 * are noise on fast tool calls, so they stay hidden until the work is slow
 * enough that a "still going" cue actually helps. Order is overall, then step,
 * then queued — most-stable signal first.
 */
export type ActivitySuffixInput = {
  elapsedSeconds: number;
  stepElapsedSeconds: number;
  queued: number;
};

export function activityRowSuffix({
  elapsedSeconds,
  stepElapsedSeconds,
  queued,
}: ActivitySuffixInput): string {
  const parts: string[] = [];
  if (elapsedSeconds >= 2) parts.push(`${elapsedSeconds}s`);
  if (stepElapsedSeconds >= 3) parts.push(`step ${stepElapsedSeconds}s`);
  if (queued > 0) parts.push(`${queued} queued`);
  return parts.map((part) => ` · ${part}`).join("");
}
