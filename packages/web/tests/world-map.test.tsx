// Interaction tests for the drill-down world map. We exercise the real geometry
// (lib/geo/atlas projects bundled TopoJSON) and assert the click → zoom →
// per-country view flow, plus the back control.

import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { WorldMap } from "../src/components/world-map";

function clickContinent(container: HTMLElement, code: string) {
  const path = container.querySelector(`path[data-continent="${code}"]`);
  expect(path, `expected a country path for continent ${code}`).toBeTruthy();
  fireEvent.click(path as Element);
}

function clickCountry(container: HTMLElement, a2: string) {
  const path = container.querySelector(`path[data-a2="${a2}"]`);
  expect(path, `expected a country path for ${a2}`).toBeTruthy();
  fireEvent.click(path as Element);
}

describe("WorldMap drill-down", () => {
  it("renders real country geometry, not a handful of stylised blobs", () => {
    const { container } = render(
      <WorldMap continentData={[{ code: "EU", yes: 30, no: 12 }]} total={42} />,
    );
    // 170+ projected country paths means we're using the atlas, not 6 shapes.
    expect(container.querySelectorAll("path[data-id]").length).toBeGreaterThan(150);
    // Continent labels with totals show at world level.
    expect(screen.getAllByText(/Europe/).length).toBeGreaterThan(0);
    expect(screen.getByText("42")).toBeTruthy();
  });

  it("zooms into a continent on click and back out via the World control", () => {
    const { container } = render(
      <WorldMap
        continentData={[
          { code: "EU", yes: 30, no: 12 },
          { code: "AS", yes: 10, no: 10 },
        ]}
        total={62}
      />,
    );

    const worldBtn = screen.getByRole("button", { name: /World/ });
    expect(worldBtn).toHaveProperty("disabled", true); // at world level

    clickContinent(container, "EU");

    // The drilled-in continent name appears as a header pill, and zoom-out is enabled.
    expect(screen.getAllByText(/Europe/).length).toBeGreaterThan(0);
    expect(worldBtn).toHaveProperty("disabled", false);

    fireEvent.click(worldBtn);
    expect(worldBtn).toHaveProperty("disabled", true);
  });

  it("drills a worldwide question (continent + country tallies) down to nations", () => {
    // A worldwide question now carries BOTH region:* (continent) and country:*
    // tallies. World view shades by continent; drilling in reveals the nations.
    const { container } = render(
      <WorldMap
        continentData={[
          { code: "NA", yes: 17, no: 25 },
          { code: "EU", yes: 30, no: 18 },
        ]}
        countryData={[
          { code: "US", yes: 10, no: 15 },
          { code: "CA", yes: 4, no: 6 },
          { code: "MX", yes: 3, no: 4 },
          { code: "DE", yes: 7, no: 5 },
        ]}
        total={142}
      />,
    );

    // World level: continent labels, no zoom yet.
    expect(screen.getAllByText(/North America/).length).toBeGreaterThan(0);

    clickContinent(container, "NA");

    // Per-nation labels appear for North America with their own tallies.
    expect(screen.getAllByText(/United States/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Canada/).length).toBeGreaterThan(0);

    clickCountry(container, "US");
    expect(screen.getByText(/10 yes/)).toBeTruthy();
  });

  it("opens zoomed into focusContinent and shades countries by their own vote", () => {
    const { container } = render(
      <WorldMap
        continentData={[]}
        countryData={[
          { code: "DE", yes: 12, no: 6 },
          { code: "FR", yes: 6, no: 5 },
        ]}
        total={29}
        focusContinent="EU"
      />,
    );

    // Already drilled in (focusContinent), so zoom-out is available.
    expect(screen.getByRole("button", { name: /World/ })).toHaveProperty(
      "disabled",
      false,
    );

    // Per-country labels render for countries that have tallies.
    expect(screen.getAllByText(/Germany/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/France/).length).toBeGreaterThan(0);

    // Tapping a country surfaces its split in the caption (works without hover).
    clickCountry(container, "DE");
    expect(screen.getByText(/12 yes/)).toBeTruthy();
  });
});
