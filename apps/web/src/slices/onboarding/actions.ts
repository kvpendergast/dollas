"use server";

import { revalidatePath } from "next/cache";
import { requireBooks } from "@/slices/access/guard";
import { addStarterCategories, dismissOnboarding, resumeOnboarding } from "./service";

export type OnboardingFormState = { error: string; notice?: string };

function refresh() {
  revalidatePath("/");
  revalidatePath("/settings");
}

export async function dismissOnboardingAction(): Promise<OnboardingFormState> {
  const books = await requireBooks();
  const result = await dismissOnboarding({ userId: books.userId, householdId: books.householdId });
  if (!result.ok) return { error: result.memberMessage };
  refresh();
  return { error: "", notice: "Checklist hidden. Bring it back any time from Home or Settings." };
}

export async function resumeOnboardingAction(): Promise<OnboardingFormState> {
  const books = await requireBooks();
  const result = await resumeOnboarding({ userId: books.userId, householdId: books.householdId });
  if (!result.ok) return { error: result.memberMessage };
  refresh();
  return { error: "", notice: "The setup checklist is back on Home." };
}

export async function addStarterCategoriesAction(): Promise<OnboardingFormState> {
  const books = await requireBooks();
  const result = await addStarterCategories({ userId: books.userId, householdId: books.householdId });
  if (!result.ok) return { error: result.memberMessage };
  refresh();
  revalidatePath("/categories");
  revalidatePath("/activity");
  revalidatePath("/plan");
  const added = result.value.categoriesAdded.length;
  return {
    error: "",
    notice: added === 0 ? "Those categories are already here." : `Added ${added} categories in ${result.value.groupsAdded.length} groups. Rename or remove any of them on Categories.`,
  };
}
