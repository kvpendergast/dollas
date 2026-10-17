"use client";

import * as React from "react";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";

/**
 * FormField: Label + control + description + error, with the ids and aria wiring done once.
 * Pass the control as a render function and spread the props it receives:
 *   <FormField label="Name" description="Shown on the account list" error={state.error}>
 *     {(props) => <Input name="name" {...props} />}
 *   </FormField>
 * `props` carries id, aria-describedby and aria-invalid. Pass `id` to fix the control id.
 */
export function FormField({
  label,
  description,
  error,
  id,
  className,
  children,
}: {
  label: React.ReactNode;
  description?: React.ReactNode;
  error?: string;
  id?: string;
  className?: string;
  children: (props: { id: string; "aria-describedby"?: string; "aria-invalid"?: true }) => React.ReactNode;
}) {
  const auto = React.useId();
  const controlId = id ?? auto;
  const helpId = `${controlId}-help`;
  const errorId = `${controlId}-error`;
  const describedBy = [description ? helpId : null, error ? errorId : null].filter(Boolean).join(" ") || undefined;
  return (
    <Field className={className}>
      <FieldLabel htmlFor={controlId}>{label}</FieldLabel>
      {children({ id: controlId, "aria-describedby": describedBy, "aria-invalid": error ? true : undefined })}
      {description ? <FieldDescription id={helpId}>{description}</FieldDescription> : null}
      <FieldError id={errorId}>{error}</FieldError>
    </Field>
  );
}
