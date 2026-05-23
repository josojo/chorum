import { describe, expect, it } from "vitest";
import { describeClose, formatAbsoluteUTC, formatRelative } from "@/lib/time";

const now = new Date("2026-05-23T12:00:00Z");
const mins = (n: number) => new Date(now.getTime() + n * 60_000);
const hours = (n: number) => mins(n * 60);
const days = (n: number) => hours(n * 24);

describe("formatRelative", () => {
  it("collapses sub-minute deltas to 'just now'", () => {
    expect(formatRelative(mins(0), now)).toBe("just now");
    expect(formatRelative(new Date(now.getTime() + 20_000), now)).toBe("just now");
  });

  it("formats past instants with 'ago'", () => {
    expect(formatRelative(mins(-5), now)).toBe("5 minutes ago");
    expect(formatRelative(hours(-2), now)).toBe("2 hours ago");
    expect(formatRelative(days(-3), now)).toBe("3 days ago");
  });

  it("formats future instants with 'in'", () => {
    expect(formatRelative(mins(1), now)).toBe("in 1 minute");
    expect(formatRelative(hours(5), now)).toBe("in 5 hours");
    expect(formatRelative(days(10), now)).toBe("in 1 week");
  });
});

describe("describeClose", () => {
  it("flags questions closing within a day as 'soon'", () => {
    expect(describeClose(hours(3), now)).toEqual({
      label: "closes in 3 hours",
      urgency: "soon",
    });
  });

  it("treats further-out closes as 'open'", () => {
    expect(describeClose(days(5), now)).toEqual({
      label: "closes in 5 days",
      urgency: "open",
    });
  });

  it("marks past close times and non-open status as 'closed'", () => {
    expect(describeClose(hours(-2), now).urgency).toBe("closed");
    expect(describeClose(hours(-2), now).label).toBe("closed 2 hours ago");
    expect(describeClose(days(5), now, "closed").urgency).toBe("closed");
  });
});

describe("formatAbsoluteUTC", () => {
  it("renders a stable UTC stamp", () => {
    expect(formatAbsoluteUTC(now)).toBe("2026-05-23 12:00 UTC");
  });
});
