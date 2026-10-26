"use client";
import { Children, Fragment, isValidElement, useRef, useState, type ReactNode } from "react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
type Change = { target: { value: string }; currentTarget: { value: string } };
type Props = Omit<React.ComponentProps<"select">, "onChange" | "value" | "defaultValue" | "multiple" | "size"> & {
  /** The trigger's size, as the shared select has them. */
  size?: "sm" | "default";
  value?: string | number; defaultValue?: string | number; onChange?: (event: Change) => void;
};
type Item = { value: string; label: ReactNode; hint?: string; disabled: boolean };
/** Reads `<option>`s; an option's `data-hint` shows under its name in the menu but not in the closed control. */
function options(children: ReactNode): Item[] {
  const result: Item[] = [];
  Children.forEach(children, child => {
    if (!isValidElement<{ children?: ReactNode; value?: string | number; disabled?: boolean; "data-hint"?: string }>(child)) return;
    if (child.type === Fragment || child.type === "optgroup") result.push(...options(child.props.children));
    else if (child.type === "option") result.push({ value: String(child.props.value ?? child.props.children ?? ""), label: child.props.children, hint: child.props["data-hint"], disabled: !!child.props.disabled });
  });
  return result;
}
/** Shared adapter keeps existing field logic while the control uses shadcn Select. */
export function OptionSelect({ children, value, defaultValue = "", onChange, className, disabled, required, name, id, ...props }: Props) {
  const [internal, setInternal] = useState(String(defaultValue));
  const keyboardDispatch = useRef<KeyboardEvent | null>(null), triggerProps = props as React.ComponentProps<typeof SelectTrigger>;
  const items = options(children), selected = String(value ?? internal);
  const label = items.find(item => item.value === selected)?.label ?? selected;
  return <Select value={selected} disabled={disabled} required={required} name={name}
    items={items.map(item => ({ value: item.value, label: item.label }))}
    onValueChange={(next, details) => {
      // Collection registration can briefly lose a replaced option. That is not a field edit.
      // Base UI's closed-list typeahead also uses this synthetic reason, synchronously inside keydown.
      if (details.reason === "none" && details.event.type === "base-ui" && !keyboardDispatch.current) { details.cancel(); return; }
      if (next == null) return; const value = String(next); setInternal(value); onChange?.({ target: { value }, currentTarget: { value } });
    }}>
    <SelectTrigger {...triggerProps} id={id} className={className} data-value={selected} onKeyDown={event => {
      const key = event.nativeEvent; keyboardDispatch.current = key;
      queueMicrotask(() => { if (keyboardDispatch.current === key) keyboardDispatch.current = null; });
      triggerProps.onKeyDown?.(event);
    }}><SelectValue placeholder={label}>{label}</SelectValue></SelectTrigger>
    <SelectContent alignItemWithTrigger={false} className="elpis-select-content">{items.map(item => <SelectItem key={item.value} value={item.value} disabled={item.disabled} data-value={item.value}>{item.hint ? <span className="select-option">{item.label}<small>{item.hint}</small></span> : item.label}</SelectItem>)}</SelectContent>
  </Select>;
}
