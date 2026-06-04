// Behavior test for the "Get heard" supply-side explainer/simulator.
//
// Covers: it does NOT auto-open (only "How it works" does), the trigger opens
// it, Next/Back walk the four steps, and the final step exposes the external
// "Get the skill" CTA pointing at the skill docs.
//
// Fake timers keep the per-step simulation interval from firing mid-assertion.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { EarnExplainer } from "../src/components/earn-explainer";

describe("EarnExplainer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    cleanup();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not auto-open; only opens from the trigger", () => {
    render(<EarnExplainer />);
    expect(screen.queryByRole("dialog")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /get heard/i }));
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByText("Add WorldSignal to your agent")).toBeTruthy();
    expect(screen.getByText(/step 1 of 4/i)).toBeTruthy();
  });

  it("walks all four steps to the Get-the-skill CTA", () => {
    render(<EarnExplainer />);
    fireEvent.click(screen.getByRole("button", { name: /get heard/i }));

    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByText("Verify once with Self")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByText("Your agent answers for you")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByText("Get heard — and earn")).toBeTruthy();

    // Last step: Next is gone, the external CTA is present.
    expect(screen.queryByRole("button", { name: "Next" })).toBeNull();
    const cta = screen.getByRole("link", { name: /get the skill/i });
    expect(cta.getAttribute("href")).toContain("/packages/skill");
    expect(cta.getAttribute("target")).toBe("_blank");
  });

  it("Back returns to the previous step", () => {
    render(<EarnExplainer />);
    fireEvent.click(screen.getByRole("button", { name: /get heard/i }));
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByText("Verify once with Self")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByText("Add WorldSignal to your agent")).toBeTruthy();
  });
});
