"use server";

import { revalidatePath } from "next/cache";
import { requireBooks } from "@/slices/access/guard";
import { createSavedFilter, deleteSavedFilter, renameSavedFilter } from "./service";

/** Thin wrappers for Activity and History. The logic is in ./service, which MCP tools call too. */

export type SavedFilterFormState = { error: string; message: string };

function revalidateFilters() {
  revalidatePath("/activity");
  revalidatePath("/history");
}

function parseFilter(raw: FormDataEntryValue | null): unknown {
  try {
    return JSON.parse(String(raw ?? "{}"));
  } catch {
    return null;
  }
}

export async function saveFilterAction(_state: SavedFilterFormState, formData: FormData): Promise<SavedFilterFormState> {
  const books = await requireBooks();
  const result = await createSavedFilter(books, { name: String(formData.get("name") ?? ""), filter: parseFilter(formData.get("filter")) });
  if (!result.ok) return { error: result.memberMessage, message: "" };
  revalidateFilters();
  return { error: "", message: `Saved “${result.value.name}”.` };
}

export async function renameSavedFilterAction(_state: SavedFilterFormState, formData: FormData): Promise<SavedFilterFormState> {
  const books = await requireBooks();
  const result = await renameSavedFilter(books, String(formData.get("id") ?? ""), String(formData.get("name") ?? ""));
  if (!result.ok) return { error: result.memberMessage, message: "" };
  revalidateFilters();
  return { error: "", message: `Renamed to “${result.value.name}”.` };
}

export async function deleteSavedFilterAction(_state: SavedFilterFormState, formData: FormData): Promise<SavedFilterFormState> {
  const books = await requireBooks();
  const result = await deleteSavedFilter(books, String(formData.get("id") ?? ""));
  if (!result.ok) return { error: result.memberMessage, message: "" };
  revalidateFilters();
  return { error: "", message: `Deleted “${result.value.name}”.` };
}
