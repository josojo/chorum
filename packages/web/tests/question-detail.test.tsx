// Rendering test for the question detail view.
//
// Covers the load-bearing claim from ARCHITECTURE.md §4: the detail page
// surfaces the per-predicate breakdown from `aggregates.by_predicate`.
// We render <QuestionDetail/> with seeded data and assert that the
// dimensions, values, and counts all appear in the DOM.

import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { QuestionDetail } from "../src/components/question-detail";
import { groupByDimension } from "../src/components/aggregate-chart";

// The detail view embeds <LiveRefresh/>, which calls useRouter — no provider
// exists in the test env, so stub next/navigation.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

describe("QuestionDetail rendering", () => {
  const baseQuestion = {
    id: "q-1",
    text: "Should the EU adopt policy X?",
    topic: "politics",
    options: ["yes", "no"],
    status: "open",
    createdAt: new Date("2026-05-19T10:00:00Z"),
    closesAt: new Date("2026-05-26T10:00:00Z"),
  };

  it("renders the question text and topic", () => {
    render(
      <QuestionDetail
        question={baseQuestion}
        totalAnswers={0}
        byPredicate={{}}
      />,
    );
    expect(
      screen.getByText("Should the EU adopt policy X?"),
    ).toBeTruthy();
    expect(screen.getByText("#politics")).toBeTruthy();
  });

  it("renders the predicate breakdown from aggregates.by_predicate", () => {
    const byPredicate = {
      "region:EU": { yes: 30, no: 12 }, // 42 total
      "region:non-EU": { yes: 6, no: 12 }, // 18 total
      "age_band:18-24": { yes: 5, no: 2 }, // 7
      "age_band:25-34": { yes: 20, no: 10 }, // 30
      "age_band:35-44": { yes: 14, no: 9 }, // 23
    };

    render(
      <QuestionDetail
        question={baseQuestion}
        totalAnswers={60}
        byPredicate={byPredicate}
      />,
    );

    // Total surfaces.
    expect(screen.getByText("60")).toBeTruthy();

    // Geography always sits at the top; age comes beneath it.
    expect(screen.getByText("Geography")).toBeTruthy();
    expect(screen.getByText("Age")).toBeTruthy();

    // Known continent codes surface on the world map, labelled with the
    // total response count (yes + no).
    expect(screen.getAllByText(/Europe/i).length).toBeGreaterThan(0);
    expect(screen.getByText("42")).toBeTruthy();

    // Unknown geography values still surface in the ranked region list.
    expect(screen.getByText("non-EU")).toBeTruthy();

    // Age bands surface in the age chart, with their yes/no split.
    expect(screen.getByText("25-34")).toBeTruthy();
    expect(screen.getByText("20")).toBeTruthy(); // 25-34 yes count
    expect(screen.getByText("10")).toBeTruthy(); // 25-34 no count
  });

  it("does not render individual envelopes or stable user identifiers", () => {
    render(
      <QuestionDetail
        question={baseQuestion}
        totalAnswers={2}
        byPredicate={{ "region:EU": { yes: 1, no: 1 } }}
      />,
    );

    expect(screen.queryByText("Answers")).toBeNull();
    expect(screen.queryByText(/user /i)).toBeNull();
  });

  it("shows an empty-state when there are no answers", () => {
    render(
      <QuestionDetail
        question={baseQuestion}
        totalAnswers={0}
        byPredicate={{}}
      />,
    );

    expect(
      screen.getByText(/No answers yet/i),
    ).toBeTruthy();
  });

  it("surfaces no_signal as a first-class 'no formed view' breakdown (§1.14)", () => {
    render(
      <QuestionDetail
        question={baseQuestion}
        totalAnswers={20}
        byPredicate={{ "region:EU": { yes: 9, no: 6 } }} // 15 signal
        noSignalTotal={5}
        noSignalByPredicate={{ "region:EU": 5 }}
      />,
    );
    // Headline chip + section.
    expect(screen.getByText("No formed view")).toBeTruthy();
    expect(screen.getAllByText(/no formed view/i).length).toBeGreaterThan(0);
    // Overall rate 5/20 = 25%, shown as the section subtitle.
    expect(screen.getByText("25% overall")).toBeTruthy();
    // Per-group rate: EU = 5 / (15 + 5) = 25%, with the raw count alongside.
    expect(screen.getByText("(5)")).toBeTruthy();
  });

  it("does not render the no-formed-view section when nobody abstained", () => {
    render(
      <QuestionDetail
        question={baseQuestion}
        totalAnswers={5}
        byPredicate={{ "region:EU": { yes: 5, no: 0 } }}
        noSignalTotal={0}
        noSignalByPredicate={{}}
      />,
    );
    expect(screen.queryByText("No formed view")).toBeNull();
  });

  it("shows results (not the empty-state) when every answer was no_signal", () => {
    render(
      <QuestionDetail
        question={baseQuestion}
        totalAnswers={3}
        byPredicate={{}}
        noSignalTotal={3}
        noSignalByPredicate={{ "region:EU": 3 }}
      />,
    );
    expect(screen.queryByText(/No answers yet/i)).toBeNull();
    expect(screen.getByText("No formed view")).toBeTruthy();
  });

  it("places Geography above Age in the DOM order", () => {
    const { container } = render(
      <QuestionDetail
        question={baseQuestion}
        totalAnswers={60}
        byPredicate={{
          "region:EU": { yes: 30, no: 12 },
          "age_band:25-34": { yes: 12, no: 6 },
        }}
      />,
    );
    const headings = Array.from(
      container.querySelectorAll("h2"),
    ).map((h) => h.textContent);
    const geoIdx = headings.indexOf("Geography");
    const ageIdx = headings.indexOf("Age");
    expect(geoIdx).toBeGreaterThanOrEqual(0);
    expect(ageIdx).toBeGreaterThan(geoIdx);
  });
});

describe("groupByDimension", () => {
  it("splits 'dim:value' keys correctly and sorts values by total desc", () => {
    const grouped = groupByDimension({
      "region:EU": { yes: 30, no: 12 }, // 42
      "region:non-EU": { yes: 6, no: 12 }, // 18
      "age_band:25-34": { yes: 20, no: 10 }, // 30
    });
    expect(Object.keys(grouped).sort()).toEqual(["age_band", "region"]);
    expect(grouped.region.map((e) => e.value)).toEqual(["EU", "non-EU"]);
    expect(grouped.region[0].tally).toEqual({ yes: 30, no: 12 });
  });

  it("ignores values that are not tallies", () => {
    const grouped = groupByDimension({
      "region:EU": { yes: 10, no: 0 },
      // @ts-expect-error — intentionally bad input
      "region:bad": "oops",
    });
    expect(grouped.region.length).toBe(1);
  });

  it("groups keys without a ':' under 'other'", () => {
    const grouped = groupByDimension({ standalone: { yes: 5, no: 0 } });
    expect(grouped.other).toEqual([
      { value: "standalone", tally: { yes: 5, no: 0 } },
    ]);
  });

  it("handles N-option tallies", () => {
    const grouped = groupByDimension({
      "region:EU": { pizza: 22, pasta: 14, sushi: 9 },
      "region:AS": { pizza: 3, pasta: 5, sushi: 18 },
    });
    expect(grouped.region.map((e) => e.value)).toEqual(["EU", "AS"]);
    expect(grouped.region[0].tally).toEqual({ pizza: 22, pasta: 14, sushi: 9 });
  });
});
