import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * Table (shadcn). Compose Table > TableHeader/TableBody > TableRow > TableHead/TableCell.
 * The wrapper scrolls sideways on phones so wide tables never overflow the page.
 */
function Table({
  className,
  containerProps,
  ...props
}: React.ComponentProps<"table"> & { containerProps?: React.ComponentProps<"div"> }) {
  return (
    <div data-slot="table-container" {...containerProps} className={cn("w-full overflow-x-auto", containerProps?.className)}>
      <table data-slot="table" className={cn("w-full caption-bottom text-left text-sm", className)} {...props} />
    </div>
  );
}

function TableHeader({ className, ...props }: React.ComponentProps<"thead">) {
  return <thead data-slot="table-header" className={cn("border-b-2 border-border bg-secondary", className)} {...props} />;
}

function TableBody({ className, ...props }: React.ComponentProps<"tbody">) {
  return <tbody data-slot="table-body" className={cn("[&_tr:last-child]:border-0", className)} {...props} />;
}

function TableRow({ className, ...props }: React.ComponentProps<"tr">) {
  return <tr data-slot="table-row" className={cn("border-b border-border-soft", className)} {...props} />;
}

function TableHead({ className, ...props }: React.ComponentProps<"th">) {
  return <th data-slot="table-head" className={cn("px-3 py-2 text-left align-middle font-bold whitespace-nowrap", className)} {...props} />;
}

function TableCell({ className, ...props }: React.ComponentProps<"td">) {
  return <td data-slot="table-cell" className={cn("px-3 py-2 align-middle", className)} {...props} />;
}

function TableCaption({ className, ...props }: React.ComponentProps<"caption">) {
  return <caption data-slot="table-caption" className={cn("mt-2 text-sm text-muted-foreground", className)} {...props} />;
}

export { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow };
