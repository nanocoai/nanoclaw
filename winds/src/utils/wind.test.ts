import { describe, expect, it } from "vitest";
import { windComponentAlongRoad } from "./wind";

describe("wind helpers", () => {
  it("keeps wind strength for a parallel street", () => {
    expect(windComponentAlongRoad(4, 90, 90)).toBeCloseTo(4, 6);
  });

  it("drops the along-road component for a cross street", () => {
    expect(windComponentAlongRoad(4, 0, 90)).toBeCloseTo(0, 6);
  });
});
