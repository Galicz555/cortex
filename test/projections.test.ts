import { describe, expect, it } from "vitest";
import {
  clampProbability,
  isNotifyWorthy,
  toBrierScore,
  toCalibrationRows,
  toDueDate,
} from "../src/projections.ts";
import type { Projection } from "../src/store.ts";

const settled = (probability: number, status: Projection["status"]): Projection => ({
  id: 1,
  claim: "c",
  horizon: "3m",
  made_on: "2026-10-01",
  due_on: "2027-01-01",
  probability,
  basis: "b",
  projects: [],
  status,
  resolved_on: status === "open" ? null : "2027-01-01",
  resolution: null,
});

describe("forecast scoring", () => {
  it("scores settled forecasts only, ignoring open and void ones", () => {
    const score = toBrierScore([
      settled(0.8, "true"),
      settled(0.8, "false"),
      settled(0.5, "open"),
      settled(0.9, "void"),
    ]);
    expect(score).toBeCloseTo((0.04 + 0.64) / 2);
  });

  it("has no score before anything settles", () => {
    expect(toBrierScore([settled(0.5, "open")])).toBeNull();
  });

  it("groups calibration by 20% band, a 100%-edge forecast in the top band", () => {
    expect(
      toCalibrationRows([settled(0.97, "true"), settled(0.85, "false"), settled(0.1, "false")]),
    ).toEqual(["- stated 0-20%: 0/1 came true (0%)", "- stated 80-100%: 1/2 came true (50%)"]);
  });
});

describe("forecast bounds", () => {
  it("never states certainty", () => {
    expect(clampProbability(1)).toBe(0.97);
    expect(clampProbability(0)).toBe(0.03);
    expect(clampProbability(0.4)).toBe(0.4);
  });

  it("dates a forecast by its horizon, a 2-3 year one at 30 months", () => {
    expect(toDueDate("2026-10-01", "3m")).toBe("2027-01-01");
    expect(toDueDate("2026-10-01", "2-3y")).toBe("2029-04-01");
  });

  it("notifies only for likely, near forecasts that touch a project", () => {
    const base = { claim: "c", dueOn: "x", basis: "b", horizon: "6m" as const };
    expect(isNotifyWorthy({ ...base, probability: 0.7, projects: ["notes-app"] })).toBe(true);
    expect(isNotifyWorthy({ ...base, probability: 0.69, projects: ["notes-app"] })).toBe(false);
    expect(isNotifyWorthy({ ...base, probability: 0.9, projects: [] })).toBe(false);
    expect(
      isNotifyWorthy({ ...base, horizon: "12m", probability: 0.9, projects: ["notes-app"] }),
    ).toBe(false);
  });
});
