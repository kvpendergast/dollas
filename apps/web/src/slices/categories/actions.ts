"use server";

import type { CatalogDirection } from "@dollas/domain";
import { revalidatePath } from "next/cache";
import { requireBooks } from "@/slices/access/guard";
import {
  changeKind,
  createCategory,
  createCategoryGroup,
  moveCategoryToGroup,
  removeGroup,
  renameGroup,
  shiftCategoryOrder,
  shiftGroupOrder,
} from "./service";

/** Thin form wrappers. The logic is in ./service, which MCP tools call too. */

const UNGROUPED = "ungrouped";

function revalidateCategoryViews() {
  revalidatePath("/categories");
  revalidatePath("/activity");
  revalidatePath("/plan");
  revalidatePath("/history");
  revalidatePath("/projection");
  revalidatePath("/");
}

function done(result: { ok: true } | { ok: false; memberMessage: string }) {
  if (!result.ok) return { error: result.memberMessage };
  revalidateCategoryViews();
  return { error: "" };
}

function field(formData: FormData, name: string): string {
  return String(formData.get(name) ?? "");
}

function readDirection(formData: FormData): CatalogDirection | null {
  const value = formData.get("direction");
  return value === "up" || value === "down" ? value : null;
}

function removalDestination(formData: FormData): string | null | undefined {
  if (!formData.has("destination")) return undefined;
  const raw = field(formData, "destination").trim();
  if (raw.length === 0) return undefined;
  if (raw === UNGROUPED) return null;
  return raw;
}

export async function createCategoryGroupAction(_state: { error: string }, formData: FormData) {
  const books = await requireBooks();
  return done(await createCategoryGroup(books, field(formData, "name")));
}

export async function createCategoryAction(_state: { error: string }, formData: FormData) {
  const books = await requireBooks();
  return done(
    await createCategory(books, { name: field(formData, "name"), kind: field(formData, "kind"), groupId: field(formData, "groupId") }),
  );
}

export async function renameCategoryGroupAction(_state: { error: string }, formData: FormData) {
  const books = await requireBooks();
  return done(await renameGroup(books, field(formData, "groupId"), field(formData, "name")));
}

export async function moveCategoryAction(_state: { error: string }, formData: FormData) {
  const books = await requireBooks();
  const raw = field(formData, "destination").trim();
  if (raw.length === 0) return { error: "Choose where that category should go." };
  return done(await moveCategoryToGroup(books, field(formData, "categoryId"), raw === UNGROUPED ? null : raw));
}

export async function shiftCategoryGroupAction(_state: { error: string }, formData: FormData) {
  const books = await requireBooks();
  const direction = readDirection(formData);
  if (!direction) return { error: "Choose up or down." };
  return done(await shiftGroupOrder(books, field(formData, "groupId"), direction));
}

export async function shiftCategoryAction(_state: { error: string }, formData: FormData) {
  const books = await requireBooks();
  const direction = readDirection(formData);
  if (!direction) return { error: "Choose up or down." };
  return done(await shiftCategoryOrder(books, field(formData, "categoryId"), direction));
}

export async function changeCategoryKindAction(_state: { error: string }, formData: FormData) {
  const books = await requireBooks();
  return done(
    await changeKind(books, {
      categoryId: field(formData, "categoryId"),
      kind: field(formData, "kind"),
      confirmBudgetRemoval: formData.get("confirmBudgetRemoval") === "yes",
    }),
  );
}

export async function removeCategoryGroupAction(_state: { error: string }, formData: FormData) {
  const books = await requireBooks();
  return done(await removeGroup(books, field(formData, "groupId"), removalDestination(formData)));
}
