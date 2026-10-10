import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dismissToast, getToasts, resetToasts, successMessage, toast, TOAST_EXIT_MS, TOAST_MS } from "./toast-store";

describe("toasts (PEN-208)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetToasts();
  });
  afterEach(() => {
    resetToasts();
    vi.useRealTimers();
  });

  it("shows a confirmation, then leaves on its own", () => {
    toast("Transaction added.");
    expect(getToasts().map((item) => [item.message, item.leaving])).toEqual([["Transaction added.", false]]);
    vi.advanceTimersByTime(TOAST_MS);
    expect(getToasts()[0].leaving).toBe(true);
    vi.advanceTimersByTime(TOAST_EXIT_MS);
    expect(getToasts()).toEqual([]);
  });

  it("can be dismissed, keeps at most three, and does not stack the same message", () => {
    const id = toast("Saved.");
    dismissToast(id);
    vi.advanceTimersByTime(TOAST_EXIT_MS);
    expect(getToasts()).toEqual([]);
    for (const text of ["One", "Two", "Three", "Four"]) toast(text);
    expect(getToasts().map((item) => item.message)).toEqual(["Two", "Three", "Four"]);
    toast("Four");
    expect(getToasts().filter((item) => item.message === "Four" && !item.leaving)).toHaveLength(1);
    expect(toast("   ")).toBe(0);
  });

  it("fires on success, never on the initial state or an error", () => {
    const initial = { error: "" };
    expect(successMessage(initial, initial, "Saved.")).toBeNull();
    expect(successMessage(initial, { error: "Name the account." }, "Saved.")).toBeNull();
    expect(successMessage(initial, { error: "" }, "Account added.")).toBe("Account added.");
    expect(successMessage<{ error: string; notice?: string }>(initial, { error: "", notice: "Name saved." }, (state) => state.notice ?? "Saved.")).toBe("Name saved.");
    expect(successMessage(initial, { error: "" }, () => null)).toBeNull();
  });
});
