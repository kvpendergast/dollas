import { needsStarterCategories, TRANSFER_KIND_HELP } from "@dollas/domain";
import Link from "next/link";
import { NextStep } from "@/components/onboarding/next-step";
import { StarterCategoriesButton } from "@/components/onboarding/onboarding-forms";
import { CategoryForm, CategoryGroupForm } from "@/components/forms/category-forms";
import { CategoryOrganizer } from "@/components/forms/category-organizer";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { requireBooks } from "@/slices/access/guard";
import { loadCategoryCatalog } from "@/slices/books/queries";

export default async function CategoriesPage() {
  const books = await requireBooks();
  const catalog = await loadCategoryCatalog(books);
  const groups = catalog.groups.map((group) => ({
    id: group.id,
    name: group.name,
    categories: group.categories.map((item) => ({
      id: item.id,
      name: item.name,
      kind: item.kind,
      budgetCount: item.budgetCount,
    })),
  }));
  const ungrouped = catalog.ungrouped.map((item) => ({
    id: item.id,
    name: item.name,
    kind: item.kind,
    budgetCount: item.budgetCount,
  }));
  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-serif text-4xl">Categories</h1>
        <p className="max-w-xl text-sm text-muted-foreground">
          A group holds categories. Transactions and budgets use categories, not groups. A category is income, an
          expense, or a transfer. {TRANSFER_KIND_HELP}
        </p>
      </div>
      {needsStarterCategories([...groups.flatMap((group) => group.categories), ...ungrouped]) ? (
        <NextStep
          title={groups.length === 0 && ungrouped.length === 0 ? "No categories yet" : "Only the Uncategorized fallbacks so far"}
          body="Start from a ready-made set (Income, Home, Food, Getting around, Health, Fun, Giving and gifts) and rename or remove anything later. Or build your own: add a group, then categories in it."
          extra={
            <>
              <StarterCategoriesButton />
              <Link href="#add-group" className="inline-flex h-8 items-center px-2 text-sm font-medium text-primary underline-offset-4 hover:underline">
                Make my own
              </Link>
            </>
          }
        />
      ) : null}
      {groups.length === 0 && ungrouped.length === 0 ? null : <CategoryOrganizer groups={groups} ungrouped={ungrouped} />}
      <Card id="add-group" className="scroll-mt-20">
        <CardHeader>
          <CardTitle>Add a group</CardTitle>
        </CardHeader>
        <CardContent>
          <CategoryGroupForm />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Add a category</CardTitle>
          <CardDescription>Income, expense, and transfer can share a group.</CardDescription>
        </CardHeader>
        <CardContent>
          <CategoryForm groups={catalog.groups.map((group) => ({ id: group.id, name: group.name }))} />
        </CardContent>
      </Card>
    </div>
  );
}
