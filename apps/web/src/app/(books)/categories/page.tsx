import { categoryKindLabel, isCategoryKind } from "@dollas/domain";
import { CategoryForm, CategoryGroupForm } from "@/components/forms/category-forms";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { requireBooks } from "@/slices/access/guard";
import { loadCategoryCatalog } from "@/slices/books/queries";

function kindLabel(kind: string): string {
  return isCategoryKind(kind) ? categoryKindLabel(kind) : kind;
}

export default async function CategoriesPage() {
  const books = await requireBooks();
  const catalog = await loadCategoryCatalog(books);
  const sections = [
    ...catalog.groups.map((group) => ({ id: group.id, name: group.name, categories: group.categories })),
    ...(catalog.ungrouped.length > 0
      ? [{ id: "ungrouped", name: "Ungrouped", categories: catalog.ungrouped }]
      : []),
  ];
  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-serif text-4xl">Categories</h1>
        <p className="text-sm text-muted-foreground">
          Groups belong to this household. A category is income, an expense, or a transfer.
        </p>
      </div>
      {sections.length === 0 ? (
        <p className="text-sm text-muted-foreground">No categories yet. Add a group, then a category.</p>
      ) : (
        <div className="space-y-3">
          {sections.map((section) => (
            <Card key={section.id}>
              <CardHeader>
                <CardTitle>{section.name}</CardTitle>
                {section.categories.length === 0 ? (
                  <CardDescription>No categories in this group yet.</CardDescription>
                ) : null}
              </CardHeader>
              {section.categories.length > 0 ? (
                <CardContent>
                  <ul className="divide-y divide-border">
                    {section.categories.map((item) => (
                      <li key={item.id} className="flex items-center justify-between gap-3 py-2 first:pt-0 last:pb-0">
                        <span>{item.name}</span>
                        <Badge variant="secondary">{kindLabel(item.kind)}</Badge>
                      </li>
                    ))}
                  </ul>
                </CardContent>
              ) : null}
            </Card>
          ))}
        </div>
      )}
      <Card>
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
