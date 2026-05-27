import { describe, expect, it } from "vitest";
import { angleDifference, lineBearing } from "./geometry";

describe("geometry helpers", () => {
  it("calculates a map bearing from north", () => {
    expect(lineBearing([0, 0], [1, 0])).toBeCloseTo(90, 4);
  });

  it("uses the shortest angle difference around north", () => {
    expect(angleDifference(350, 10)).toBe(20);
    expect(angleDifference(40, 220)).toBe(180);
  });
});
