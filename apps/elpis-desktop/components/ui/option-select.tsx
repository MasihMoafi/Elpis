"use client";
import { Children, Fragment, isValidElement, useState, type ReactNode } from "react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
type Change = { target: { value: string }; currentTarget: { value: string } };
type Props = Omit<React.ComponentProps<"select">, "onChange" | "value" | "defaultValue" | "multiple"> & {
  value?: string | number; defaultValue?: string | number; onChange?: (event: Change) => void;
};
function options(children: ReactNode): { value: string; label: ReactNode; disabled: boolean }[] {
  const result: { value: string; label: ReactNode; disabled: boolean }[] = [];
  Children.forEach(children, child => {
    if (!isValidElement<{ children?: ReactNode; value?: string | number; disabled?: boolean }>(child)) return;
    if (child.type === Fragment || child.type === "optgroup") result.push(...options(child.props.children));
    else if (child.type === "option") result.push({ value: String(child.props.value ?? child.props.children ?? ""), label: child.props.children, disabled: !!child.props.disabled });
  });
  return result;
}
/** Shared adapter keeps existing field logic while the control uses shadcn Select. */
export function OptionSelect({ children, value, defaultValue = "", onChange, className, disabled, required, name, id, ...props }: Props) {
  const [internal, setInternal] = useState(String(defaultValue));
  const items = options(children), selected = String(value ?? internal);
  const label = items.find(item => item.value === selected)?.label ?? selected;
  return <Select value={selected} disabled={disabled} required={required} name={name}
    items={items.map(item => ({ value: item.value, label: item.label }))}
    onValueChange={next => { if (next == null) return; const value = String(next); setInternal(value); onChange?.({ target: { value }, currentTarget: { value } }); }}>
    <SelectTrigger {...props as React.ComponentProps<typeof SelectTrigger>} id={id} className={className} data-value={selected}><SelectValue placeholder={label}>{label}</SelectValue></SelectTrigger>
    <SelectContent alignItemWithTrigger={false} className="elpis-select-content">{items.map(item => <SelectItem key={item.value} value={item.value} disabled={item.disabled} data-value={item.value}>{item.label}</SelectItem>)}</SelectContent>
  </Select>;
}
