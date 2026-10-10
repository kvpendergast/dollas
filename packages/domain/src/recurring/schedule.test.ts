import { describe, expect, it } from "vitest";
import { nextOccurrences, occurrencesBetween, previousOccurrence, type RecurringSchedule } from "./schedule";

const schedule = (extra: Partial<RecurringSchedule>): RecurringSchedule => ({
  cadence: "monthly",
  anchorDate: "2026-01-31",
  dayOfMonth: null,
  secondDayOfMonth: null,
  startDate: "2020-01-01",
  endDate: null,
  ...extra,
});

describe("recurring cadence math", () => {
  it("clamps the 31st to short months and keeps it in long ones", () => {
    expect(occurrencesBetween(schedule({}), "2026-01-01", "2026-05-31")).toEqual([
      "2026-01-31",
      "2026-02-28",
      "2026-03-31",
      "2026-04-30",
      "2026-05-31",
    ]);
  });

  it("uses the 29th of February in a leap year", () => {
    expect(occurrencesBetween(schedule({}), "2028-02-01", "2028-03-31")).toEqual(["2028-02-29", "2028-03-31"]);
    expect(occurrencesBetween(schedule({ cadence: "yearly", anchorDate: "2024-02-29" }), "2024-01-01", "2028-12-31")).toEqual([
      "2024-02-29",
      "2025-02-28",
      "2026-02-28",
      "2027-02-28",
      "2028-02-29",
    ]);
  });

  it("keeps an explicit day of month even when the anchor fell on a clamped day", () => {
    const s = schedule({ anchorDate: "2026-02-28", dayOfMonth: 31 });
    expect(occurrencesBetween(s, "2026-02-01", "2026-04-30")).toEqual(["2026-02-28", "2026-03-31", "2026-04-30"]);
  });

  it("steps weekly and every two weeks from the anchor in both directions", () => {
    const weekly = schedule({ cadence: "weekly", anchorDate: "2026-10-09" });
    expect(occurrencesBetween(weekly, "2026-09-25", "2026-10-16")).toEqual(["2026-09-25", "2026-10-02", "2026-10-09", "2026-10-16"]);
    const biweekly = schedule({ cadence: "biweekly", anchorDate: "2026-10-09" });
    expect(occurrencesBetween(biweekly, "2026-09-20", "2026-11-10")).toEqual(["2026-09-25", "2026-10-09", "2026-10-23", "2026-11-06"]);
    // Across a year end and a DST change, still exactly 14 days.
    expect(occurrencesBetween(biweekly, "2026-12-20", "2027-01-20")).toEqual(["2027-01-01", "2027-01-15"]);
  });

  it("runs twice a month on two clamped days, once when they collapse", () => {
    const s = schedule({ cadence: "semimonthly", anchorDate: "2026-01-15", dayOfMonth: 15, secondDayOfMonth: 31 });
    expect(occurrencesBetween(s, "2026-02-01", "2026-04-30")).toEqual([
      "2026-02-15",
      "2026-02-28",
      "2026-03-15",
      "2026-03-31",
      "2026-04-15",
      "2026-04-30",
    ]);
    const collapse = schedule({ cadence: "semimonthly", anchorDate: "2026-01-30", secondDayOfMonth: 31 });
    expect(occurrencesBetween(collapse, "2026-02-01", "2026-02-28")).toEqual(["2026-02-28"]);
    const firstAndFifteenth = schedule({ cadence: "semimonthly", anchorDate: "2026-01-15", secondDayOfMonth: 1 });
    expect(occurrencesBetween(firstAndFifteenth, "2026-01-01", "2026-01-31")).toEqual(["2026-01-01", "2026-01-15"]);
  });

  it("counts quarters and years from the anchor month", () => {
    const quarterly = schedule({ cadence: "quarterly", anchorDate: "2026-11-30" });
    expect(occurrencesBetween(quarterly, "2026-01-01", "2027-12-31")).toEqual([
      "2026-02-28",
      "2026-05-30",
      "2026-08-30",
      "2026-11-30",
      "2027-02-28",
      "2027-05-30",
      "2027-08-30",
      "2027-11-30",
    ]);
  });

  it("has no lower bound without a start date", () => {
    const s = schedule({ anchorDate: "2026-11-01", startDate: null });
    expect(occurrencesBetween(s, "2026-08-01", "2026-10-31")).toEqual(["2026-08-01", "2026-09-01", "2026-10-01"]);
  });

  it("respects start and end dates", () => {
    const s = schedule({ anchorDate: "2026-01-05", startDate: "2026-03-01", endDate: "2026-05-05" });
    expect(occurrencesBetween(s, "2026-01-01", "2026-12-31")).toEqual(["2026-03-05", "2026-04-05", "2026-05-05"]);
    expect(occurrencesBetween(s, "2026-06-01", "2026-12-31")).toEqual([]);
  });

  it("finds the next and previous occurrences", () => {
    const s = schedule({ anchorDate: "2026-01-31" });
    expect(nextOccurrences(s, "2026-02-01", 3)).toEqual(["2026-02-28", "2026-03-31", "2026-04-30"]);
    expect(nextOccurrences(schedule({ cadence: "yearly", anchorDate: "2026-07-04" }), "2026-07-05", 2)).toEqual(["2027-07-04", "2028-07-04"]);
    expect(previousOccurrence(s, "2026-03-30")).toBe("2026-02-28");
    expect(nextOccurrences(schedule({ endDate: "2026-02-28" }), "2026-02-01", 5)).toEqual(["2026-02-28"]);
  });
});
