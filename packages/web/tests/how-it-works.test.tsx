// Behavior test for the "How it works" onboarding click-through.
//
// Covers: the trigger opens the dialog, Next/Back walk the steps, and the
// final step exposes the "Ask a question" CTA.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { HowItWorks } from "../src/components/how-it-works";

// next/navigation's useRouter has no provider in the test env — stub it.
const push = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
}));

describe("HowItWorks", () => {
  beforeEach(() => {
    cleanup();
    push.mockClear();
  });

  it("does not auto-open on first visit", () => {
    render(<HowItWorks />);
    expect(screen.queryByRole("dialog")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /how it works/i }));
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("opens from the trigger and walks all three steps", () => {
    render(<HowItWorks />);

    fireEvent.click(screen.getByRole("button", { name: /how it works/i }));

    expect(screen.getByText("Ask anyone, anywhere")).toBeTruthy();
    expect(screen.getByText(/Step 1 of 3/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByText("Personal agent infer answer")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByText("Watch live, private results")).toBeTruthy();

    // Last step swaps Next for the CTA.
    expect(screen.queryByRole("button", { name: "Next" })).toBeNull();
    const cta = screen.getByRole("button", { name: /ask a question/i });
    fireEvent.click(cta);
    expect(push).toHaveBeenCalledWith("/ask");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("Back returns to the previous step", () => {
    render(<HowItWorks />);

    fireEvent.click(screen.getByRole("button", { name: /how it works/i }));
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByText("Personal agent infer answer")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByText("Ask anyone, anywhere")).toBeTruthy();
  });
});
