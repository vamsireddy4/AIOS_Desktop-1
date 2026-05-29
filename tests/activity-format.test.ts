import { describe, it, expect } from "vitest";
import { activityRowSuffix } from "../renderer/src/lib/activity-format";

describe("activityRowSuffix", () => {
  it("returns no suffix when everything is under threshold", () => {
    expect(activityRowSuffix({ elapsedSeconds: 1, stepElapsedSeconds: 2, queued: 0 })).toBe("");
  });

  it("shows the overall time only once it reaches 2s", () => {
    expect(activityRowSuffix({ elapsedSeconds: 2, stepElapsedSeconds: 0, queued: 0 })).toBe(" · 2s");
    expect(activityRowSuffix({ elapsedSeconds: 12, stepElapsedSeconds: 2, queued: 0 })).toBe(" · 12s");
  });

  it("adds the step time once it reaches 3s, after the overall time", () => {
    expect(activityRowSuffix({ elapsedSeconds: 12, stepElapsedSeconds: 4, queued: 0 })).toBe(" · 12s · step 4s");
  });

  it("appends the queued count last", () => {
    expect(activityRowSuffix({ elapsedSeconds: 12, stepElapsedSeconds: 4, queued: 2 })).toBe(" · 12s · step 4s · 2 queued");
  });

  it("shows the queued count even when both timers are under threshold", () => {
    expect(activityRowSuffix({ elapsedSeconds: 0, stepElapsedSeconds: 0, queued: 3 })).toBe(" · 3 queued");
  });

  it("omits the queued count when the queue is empty", () => {
    expect(activityRowSuffix({ elapsedSeconds: 5, stepElapsedSeconds: 0, queued: 0 })).toBe(" · 5s");
  });
});
