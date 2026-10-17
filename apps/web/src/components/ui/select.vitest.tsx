import { describe, expect, it } from "vitest";
import { collectChoices, displayLabel } from "./select";

const grouped = (
  <>
    <option value="">Uncategorized</option>
    <optgroup label="Food">
      <option value="a">Groceries</option>
      <option value="b">Dining</option>
    </optgroup>
    {[1, 2].map((n) => (
      <optgroup key={n} label={`Bills ${n}`}>
        <option value={`r${n}`}>Rent {n}</option>
      </optgroup>
    ))}
  </>
);

describe("Select option collection (regression: category select opened empty)", () => {
  it("finds options inside optgroups, fragments and mapped arrays", () => {
    const choices = collectChoices(grouped);
    expect(choices.map((c) => c.value)).toEqual(["", "a", "b", "r1", "r2"]);
    expect(choices.find((c) => c.value === "a")?.group).toBe("Food");
    expect(choices.length).toBeGreaterThan(0);
  });

  it("shows the label for the selected value, including empty and unknown values", () => {
    const choices = collectChoices(grouped);
    expect(displayLabel(choices, "b")).toBe("Dining");
    expect(displayLabel(choices, "")).toBe("Uncategorized");
    expect(displayLabel(choices, "gone-category-id", "Choose a category")).toBe("Choose a category");
    const noEmpty = collectChoices(<option value="x">X</option>);
    expect(displayLabel(noEmpty, "")).toBe("Choose one");
  });

  it("takes an option's text as its value when no value is given", () => {
    expect(collectChoices(<option>Plain</option>)[0].value).toBe("Plain");
  });
});
