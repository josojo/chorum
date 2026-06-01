// Behavior test for the AskGate login wall in front of /ask.
//
// Covers: local/demo mode renders the form directly; gated mode auto-opens the
// explain step and hides the form; "Verify with Self" advances to the QR scan;
// Cancel closes to the locked placeholder. The network/poll path (start →
// status) is covered by the broker integration tests and asker-auth tests; we
// stub fetch here only so the scan step can mount without erroring.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup, within } from "@testing-library/react";

// Stub the real form: rendering it would pull the "use server" create-question
// action (db, next/headers) into the browser test. We only care that AskGate
// reveals *a* form and threads the session through.
vi.mock("../src/components/ask-form", () => ({
  AskForm: (props: { askerSession?: string }) => (
    <div data-testid="ask-form" data-session={props.askerSession ?? ""}>
      ask form
    </div>
  ),
}));

import { AskGate } from "../src/components/ask-gate";

describe("AskGate", () => {
  beforeEach(() => {
    cleanup();
    // Keep /api/asker-login/start pending so the scan step shows its QR/spinner
    // rather than throwing in the test environment.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    global.fetch = vi.fn(() => new Promise(() => {})) as any;
  });

  it("renders the form directly when auth is not required (local/demo)", () => {
    render(<AskGate authRequired={false} />);
    expect(screen.getByTestId("ask-form")).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("gates the form behind the explain step when auth is required", () => {
    render(<AskGate authRequired={true} />);
    // Form is not revealed yet.
    expect(screen.queryByTestId("ask-form")).toBeNull();
    // Dialog auto-opens on the explain step.
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByText(/Verify you're a unique human/i)).toBeTruthy();
    expect(screen.getByText(/step 1 of 3/i)).toBeTruthy();
    // The email fallback is offered.
    expect(screen.getByText("newquestion@hearme.fi")).toBeTruthy();
  });

  it("advances to the Self scan step", () => {
    render(<AskGate authRequired={true} />);
    // The dialog's own primary button (the placeholder behind it also has a
    // "Verify with Self" button — scope to the dialog).
    const dialog = screen.getByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: /verify with self/i }));
    expect(screen.getByText(/Scan with the Self app/i)).toBeTruthy();
    expect(screen.getByText(/step 2 of 3/i)).toBeTruthy();
  });

  it("Cancel closes the dialog to the locked placeholder", () => {
    render(<AskGate authRequired={true} />);
    fireEvent.click(screen.getByRole("button", { name: /^cancel$/i }));
    expect(screen.queryByRole("dialog")).toBeNull();
    // The placeholder lets the asker reopen the flow.
    expect(screen.getByText(/Verify to ask a question/i)).toBeTruthy();
    expect(screen.queryByTestId("ask-form")).toBeNull();
  });
});
