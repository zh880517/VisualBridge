import { Button } from "@base-ui/react/button";
import {
  ArrowDown,
  ArrowUp,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  Plus,
  Search,
  Trash2,
  X,
  type LucideIcon,
} from "lucide-react";
import type { MouseEventHandler, ReactElement } from "react";

export type CommonIconName =
  | "add"
  | "check"
  | "chevronDown"
  | "chevronRight"
  | "close"
  | "copy"
  | "delete"
  | "moveDown"
  | "moveUp"
  | "search";

export function CommonIcon(props: { readonly name: CommonIconName }): ReactElement {
  const icons: Record<CommonIconName, LucideIcon> = {
    add: Plus,
    check: Check,
    chevronDown: ChevronDown,
    chevronRight: ChevronRight,
    close: X,
    copy: Copy,
    delete: Trash2,
    moveDown: ArrowDown,
    moveUp: ArrowUp,
    search: Search,
  };
  const Icon = icons[props.name];
  return (
    <Icon className="vb-common-icon" size={16} strokeWidth={1.8} aria-hidden="true" />
  );
}

export function IconButton(props: {
  readonly className?: string;
  readonly disabled?: boolean;
  readonly icon: CommonIconName;
  readonly label: string;
  readonly onClick?: MouseEventHandler<HTMLButtonElement>;
  readonly title?: string;
}): ReactElement {
  return (
    <Button
      type="button"
      className={`icon${props.className === undefined ? "" : ` ${props.className}`}`}
      aria-label={props.label}
      title={props.title ?? props.label}
      disabled={props.disabled}
      onClick={props.onClick}
    >
      <CommonIcon name={props.icon} />
    </Button>
  );
}
