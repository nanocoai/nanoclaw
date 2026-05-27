import { describe, expect, it } from "vitest";
import { shadowLengthMeters } from "./shadows";

describe("shadow helpers", () => {
  it("calculates the length from height and sun altitude", () => {
    expect(shadowLengthMeters(12, Math.PI / 4)).toBeCloseTo(12, 6);
  });

  it("returns no direct shadow below the horizon", () => {
    expect(shadowLengthMeters(12, -0.1)).toBe(0);
  });
});
