// Behavior test for the "How it works" onboarding click-through.
//
// Covers: the trigger opens the dialog, Next/Back walk the steps, the final
// step exposes the "Ask a question" CTA, and the first-visit auto-open fires
// only until the localStorage flag is set.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { HowItWorks } from "../src/components/how-it-works";

// next/navigation's useRouter has no provider in the test env — stub it.
const push = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
}));

const SEEN_KEY = "hearme:how-it-works-seen-v1";

describe("HowItWorks", () => {
  beforeEach(() => {
    cleanup();
    push.mockClear();
    window.localStorage.clear();
  });

  it("auto-opens on first visit and sets the seen flag when dismissed", () => {
    render(<HowItWorks />);
    // Dialog is up without anyone clicking the trigger.
    expect(screen.getByRole("dialog")).toBeTruthy();

    fireEvent.click(screen.getByLabelText("Close"));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(window.localStorage.getItem(SEEN_KEY)).toBe("1");
  });

  it("does not auto-open once the seen flag is present", () => {
    window.localStorage.setItem(SEEN_KEY, "1");
    render(<HowItWorks />);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("opens from the trigger and walks all three steps", () => {
    window.localStorage.setItem(SEEN_KEY, "1");
    render(<HowItWorks />);

    fireEvent.click(screen.getByRole("button", { name: /how it works/i }));

    expect(screen.getByText("Ask anyone, anywhere")).toBeTruthy();
    expect(screen.getByText(/Step 1 of 3/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByText("Real humans answer")).toBeTruthy();

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
    window.localStorage.setItem(SEEN_KEY, "1");
    render(<HowItWorks />);

    fireEvent.click(screen.getByRole("button", { name: /how it works/i }));
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByText("Real humans answer")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByText("Ask anyone, anywhere")).toBeTruthy();
  });
});
