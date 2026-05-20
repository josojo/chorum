// Rendering test for the question detail view.
//
// Covers the load-bearing claim from ARCHITECTURE.md §4: the detail page
// surfaces the per-predicate breakdown from `aggregates.by_predicate`.
// We render <QuestionDetail/> with seeded data and assert that the
// dimensions, values, and counts all appear in the DOM.

import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { QuestionDetail } from "../src/components/question-detail";
import { groupByDimension } from "../src/components/aggregate-chart";

describe("QuestionDetail rendering", () => {
  const baseQuestion = {
    id: "q-1",
    text: "Should the EU adopt policy X?",
    topic: "politics",
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
      "region:EU": 42,
      "region:non-EU": 18,
      "age_band:18-24": 7,
      "age_band:25-34": 30,
      "age_band:35-44": 23,
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

    // Known continent codes surface on the world map.
    expect(screen.getAllByText(/Europe/i).length).toBeGreaterThan(0);
    expect(screen.getByText("42")).toBeTruthy();

    // Unknown geography values still surface in the ranked region list.
    expect(screen.getByText("non-EU")).toBeTruthy();
    expect(screen.getByText("18")).toBeTruthy();

    // Age bands and their counts surface in the age chart.
    expect(screen.getByText("25-34")).toBeTruthy();
    expect(screen.getByText("30")).toBeTruthy();
  });

  it("does not render individual envelopes or stable user identifiers", () => {
    render(
      <QuestionDetail
        question={baseQuestion}
        totalAnswers={2}
        byPredicate={{ "region:EU": 2 }}
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

  it("places Geography above Age in the DOM order", () => {
    const { container } = render(
      <QuestionDetail
        question={baseQuestion}
        totalAnswers={60}
        byPredicate={{
          "region:EU": 42,
          "age_band:25-34": 18,
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
  it("splits 'dim:value' keys correctly and sorts values by count desc", () => {
    const grouped = groupByDimension({
      "region:EU": 42,
      "region:non-EU": 18,
      "age_band:25-34": 30,
    });
    expect(Object.keys(grouped).sort()).toEqual(["age_band", "region"]);
    expect(grouped.region.map((e) => e.value)).toEqual(["EU", "non-EU"]);
    expect(grouped.region[0].count).toBe(42);
  });

  it("ignores non-numeric values", () => {
    const grouped = groupByDimension({
      "region:EU": 10,
      // @ts-expect-error — intentionally bad input
      "region:bad": "oops",
    });
    expect(grouped.region.length).toBe(1);
  });

  it("groups keys without a ':' under 'other'", () => {
    const grouped = groupByDimension({ standalone: 5 });
    expect(grouped.other).toEqual([{ value: "standalone", count: 5 }]);
  });
});
