"use client";

import { Info } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

/** HowImportWorks: the long import rules, tucked into a Popover so the Import card stays one line. */
export function HowImportWorks() {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button type="button" variant="outline" size="sm">
          <Info aria-hidden="true" />
          How import works
        </Button>
      </PopoverTrigger>
      <PopoverContent className="space-y-2">
        <p className="font-heading font-extrabold">How import works</p>
        <p>Preview the rows before they are added. Importing the same file again adds nothing.</p>
        <p>
          A transaction you delete stays deleted, and that line is not added again. Undo removes only the transactions
          that import added, so you can import the file again after that.
        </p>
      </PopoverContent>
    </Popover>
  );
}
