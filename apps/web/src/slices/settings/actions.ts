"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireBooks } from "@/slices/access/guard";
import { changeMemberEmail, changeMemberPassword } from "@/slices/settings/credentials";
import {
  deleteHousehold,
  leaveHousehold,
  transferOwnership,
  updateProfileName,
  type MembershipResult,
} from "@/slices/settings/membership";

export type SettingsFormState = {
  error: string;
  notice?: string;
};

function shown<T>(result: MembershipResult<T>): string {
  return result.ok ? "" : result.memberMessage;
}

export async function updateNameAction(_state: SettingsFormState, formData: FormData): Promise<SettingsFormState> {
  const books = await requireBooks();
  const result = await updateProfileName(
    { userId: books.userId, householdId: books.householdId },
    String(formData.get("name") ?? ""),
  );
  if (!result.ok) return { error: shown(result) };
  revalidatePath("/settings");
  return { error: "", notice: "Name saved." };
}

export async function changeEmailAction(_state: SettingsFormState, formData: FormData): Promise<SettingsFormState> {
  const books = await requireBooks();
  const result = await changeMemberEmail(
    { userId: books.userId, householdId: books.householdId },
    String(formData.get("email") ?? ""),
  );
  if (!result.ok) return { error: shown(result) };
  return { error: "", notice: result.value.notice };
}

export async function changePasswordAction(_state: SettingsFormState, formData: FormData): Promise<SettingsFormState> {
  const books = await requireBooks();
  const result = await changeMemberPassword(
    { userId: books.userId, householdId: books.householdId },
    {
      currentPassword: String(formData.get("currentPassword") ?? ""),
      newPassword: String(formData.get("newPassword") ?? ""),
      confirm: String(formData.get("confirm") ?? ""),
    },
  );
  if (!result.ok) return { error: shown(result) };
  return { error: "", notice: result.value.notice };
}

export async function transferOwnershipAction(_state: SettingsFormState, formData: FormData): Promise<SettingsFormState> {
  const books = await requireBooks();
  const result = await transferOwnership(
    { userId: books.userId, householdId: books.householdId },
    String(formData.get("memberId") ?? ""),
  );
  if (!result.ok) return { error: shown(result) };
  revalidatePath("/settings");
  return { error: "", notice: "Ownership handed off. You are a member of this household now." };
}

export async function leaveHouseholdAction(state: SettingsFormState, formData: FormData): Promise<SettingsFormState> {
  void state;
  void formData;
  const books = await requireBooks();
  const result = await leaveHousehold({ userId: books.userId, householdId: books.householdId });
  if (!result.ok) return { error: shown(result) };
  revalidatePath("/", "layout");
  redirect("/welcome");
}

export async function deleteHouseholdAction(_state: SettingsFormState, formData: FormData): Promise<SettingsFormState> {
  const books = await requireBooks();
  const result = await deleteHousehold(
    { userId: books.userId, householdId: books.householdId },
    String(formData.get("confirmation") ?? ""),
  );
  if (!result.ok) return { error: shown(result) };
  revalidatePath("/", "layout");
  redirect("/welcome");
}
