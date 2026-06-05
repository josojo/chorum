// The home hero always anchors on the world map: coloured by the most-answered
// open question when one exists, neutral ("no votes yet") otherwise. This locks
// in that the map never disappears on a fresh, empty deployment.

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { PulseHero } from "../src/components/pulse-hero";
import type { FeaturedQuestion } from "../src/lib/featured";

// <LiveRefresh/> (inside the hero) calls useRouter — no provider in the test env.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

afterEach(() => cleanup());

const FEATURED: FeaturedQuestion = {
  id: "11111111-1111-1111-1111-111111111111",
  text: "Should every online platform verify its users are real humans?",
  options: ["yes", "no"],
  totalAnswers: 1200,
  continentData: [
    { code: "EU", tally: { yes: 400, no: 120 } },
    { code: "AS", tally: { yes: 300, no: 380 } },
  ],
  countryData: [],
  tally: { yes: 700, no: 500 },
};

describe("PulseHero", () => {
  it("renders a neutral world map when there is no featured question", () => {
    render(
      <PulseHero
        signalsCaptured={0}
        verifiedPeople={null}
        questionsAsked={0}
        featured={null}
      />,
    );

    // The map (an svg with role img) is present even with zero data.
    expect(screen.getByRole("img", { name: /world map/i })).toBeTruthy();
    // ...with the neutral, invitational caption rather than a question.
    expect(screen.getByText(/no signals yet — share the first one/i)).toBeTruthy();
    // No question link when nothing is featured.
    expect(screen.queryByRole("link", { name: /q\// })).toBeNull();
  });

  it("colours the map with the featured question and links to it", () => {
    render(
      <PulseHero
        signalsCaptured={1200}
        verifiedPeople={42}
        questionsAsked={3}
        featured={FEATURED}
      />,
    );

    expect(screen.getByRole("img", { name: /world map/i })).toBeTruthy();
    expect(screen.getByText(/your chat never leaves/i)).toBeTruthy();
    // The map card links to the question detail page.
    const link = screen
      .getAllByRole("link")
      .find((a) => a.getAttribute("href") === `/q/${FEATURED.id}`);
    expect(link).toBeTruthy();
    // The live-result panel shows for a question with votes.
    expect(screen.getByText(/live result/i)).toBeTruthy();
  });
});
