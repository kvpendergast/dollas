"use client"

import * as React from "react"
import { Select as SelectPrimitive } from "radix-ui"
import { ChevronDown } from "lucide-react"
import { cn } from "@/lib/utils"

/*
 * shadcn-style Select on Radix (PEN-310 follow-up). Keyboard: arrows, type-ahead,
 * Home/End, Escape. The popover is portaled above dialogs (z-[70]).
 */

const SelectRoot = SelectPrimitive.Root
const SelectGroup = SelectPrimitive.Group
const SelectValue = SelectPrimitive.Value

function SelectTrigger({ className, children, ...props }: React.ComponentProps<typeof SelectPrimitive.Trigger>) {
  return (
    <SelectPrimitive.Trigger
      data-slot="select-trigger"
      className={cn(
        "flex h-12 w-full min-w-0 items-center justify-between gap-3 rounded-sm border-2 border-input bg-white pr-3 pl-4 text-left text-base font-medium text-foreground transition-[box-shadow,border-color] duration-(--motion-fast) ease-(--ease-out) outline-none focus-visible:border-primary focus-visible:shadow-focus disabled:cursor-not-allowed disabled:bg-muted disabled:opacity-70 aria-invalid:border-destructive aria-invalid:bg-error-tint data-[placeholder]:text-muted-foreground [&>span:first-child]:line-clamp-1",
        className,
      )}
      {...props}
    >
      {children}
      <SelectPrimitive.Icon asChild>
        <span
          aria-hidden="true"
          className="grid size-8 shrink-0 place-items-center rounded-full border-2 border-foreground bg-secondary text-foreground"
        >
          <ChevronDown size={18} strokeWidth={2.5} />
        </span>
      </SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  )
}

function SelectContent({ className, children, position = "popper", ...props }: React.ComponentProps<typeof SelectPrimitive.Content>) {
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Content
        data-slot="select-content"
        position={position}
        sideOffset={6}
        className={cn(
          "dl-sheet relative z-[70] max-h-[min(20rem,var(--radix-select-content-available-height))] min-w-[8rem] overflow-hidden rounded-md border-2 border-foreground bg-popover text-popover-foreground shadow-pop",
          position === "popper" && "w-(--radix-select-trigger-width)",
          className,
        )}
        {...props}
      >
        <SelectPrimitive.Viewport className="p-1">{children}</SelectPrimitive.Viewport>
      </SelectPrimitive.Content>
    </SelectPrimitive.Portal>
  )
}

function SelectItem({ className, children, ...props }: React.ComponentProps<typeof SelectPrimitive.Item>) {
  return (
    <SelectPrimitive.Item
      data-slot="select-item"
      className={cn(
        "relative flex min-h-11 w-full cursor-default items-center rounded-sm px-3 text-base font-medium outline-none select-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 data-[highlighted]:bg-amber data-[state=checked]:font-extrabold",
        className,
      )}
      {...props}
    >
      <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
    </SelectPrimitive.Item>
  )
}

/* ---- Form-friendly wrapper: <Select name defaultValue>…<option>…</option></Select> ---- */

const NONE = "__none__"

type Choice = { value: string; label: React.ReactNode; disabled?: boolean }

function collect(children: React.ReactNode, out: Choice[] = []): Choice[] {
  React.Children.forEach(children, (child) => {
    if (!React.isValidElement(child)) return
    const props = child.props as { value?: string | number; children?: React.ReactNode; disabled?: boolean }
    if (child.type === React.Fragment) collect(props.children, out)
    else if (child.type === "option") out.push({ value: String(props.value ?? ""), label: props.children, disabled: props.disabled })
  })
  return out
}

type SelectProps = Omit<React.ComponentProps<"select">, "onChange" | "value" | "defaultValue" | "children"> & {
  value?: string | number
  defaultValue?: string | number
  children?: React.ReactNode
  onChange?: (event: { target: { value: string } }) => void
  onValueChange?: (value: string) => void
}

/**
 * Takes native-style <option> children. The form value is posted through our own
 * hidden input so an empty option posts "" (Radix forbids "" item values and would
 * post a placeholder token). A disabled empty option becomes the placeholder.
 */
function Select({ className, children, id, name, value, defaultValue, onChange, onValueChange, required, disabled, ...rest }: SelectProps) {
  const choices = collect(children)
  const placeholder = choices.find((choice) => choice.value === "" && choice.disabled)?.label
  const items = choices.filter((choice) => !(choice.value === "" && choice.disabled))
  const hasEmptyItem = items.some((choice) => choice.value === "")
  const controlled = value !== undefined
  // Like a native select: with no default, the first enabled option is selected (and posted).
  const initial = defaultValue === undefined ? (choices.find((choice) => !choice.disabled)?.value ?? "") : String(defaultValue)
  const [inner, setInner] = React.useState(initial)
  const current = controlled ? String(value) : inner
  const inputRef = React.useRef<HTMLInputElement>(null)

  React.useEffect(() => {
    const form = inputRef.current?.form
    if (!form || controlled) return
    const onReset = () => setInner(initial)
    form.addEventListener("reset", onReset)
    return () => form.removeEventListener("reset", onReset)
  }, [controlled, initial])

  const radixValue = current === "" ? (hasEmptyItem ? NONE : "") : current
  function change(next: string) {
    const real = next === NONE ? "" : next
    if (!controlled) setInner(real)
    onValueChange?.(real)
    onChange?.({ target: { value: real } })
  }
  return (
    <>
      <SelectRoot value={radixValue} onValueChange={change} disabled={disabled}>
        <SelectTrigger id={id} className={className} aria-required={required || undefined} {...(rest as React.ComponentProps<typeof SelectPrimitive.Trigger>)}>
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>
        <SelectContent>
          {items.map((choice) => (
            <SelectItem key={choice.value || NONE} value={choice.value === "" ? NONE : choice.value} disabled={choice.disabled}>
              {choice.label}
            </SelectItem>
          ))}
        </SelectContent>
      </SelectRoot>
      {name ? <input ref={inputRef} type="hidden" name={name} value={current} /> : null}
    </>
  )
}

export { Select, SelectRoot, SelectGroup, SelectValue, SelectTrigger, SelectContent, SelectItem }
