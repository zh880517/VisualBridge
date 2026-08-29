import { Button } from "@base-ui/react/button";
import {
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  GripVertical,
  Plus,
  Search,
  Trash2,
  X,
  type LucideIcon,
} from "lucide-react";
import type { MouseEventHandler, ReactElement, Ref } from "react";

export type CommonIconName =
  | "add"
  | "check"
  | "chevronDown"
  | "chevronRight"
  | "close"
  | "copy"
  | "delete"
  | "drag"
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
    drag: GripVertical,
    search: Search,
  };
  const Icon = icons[props.name];
  return (
    <Icon className="vb-common-icon" size={16} strokeWidth={1.8} aria-hidden="true" />
  );
}

export function IconButton(props: {
  readonly buttonRef?: Ref<HTMLButtonElement>;
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
      ref={props.buttonRef}
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

export function ListItemActions(props: {
  readonly addDisabled?: boolean;
  readonly addLabel: string;
  readonly deleteDisabled?: boolean;
  readonly deleteLabel: string;
  readonly disabled?: boolean;
  readonly dragDisabled?: boolean;
  readonly dragLabel: string;
  readonly dragRef?: Ref<HTMLButtonElement>;
  readonly onAdd: MouseEventHandler<HTMLButtonElement>;
  readonly onDelete: MouseEventHandler<HTMLButtonElement>;
}): ReactElement {
  return (
    <div className="vb-list-actions" role="group" aria-label="列表项操作">
      <IconButton
        {...(props.dragRef === undefined ? {} : { buttonRef: props.dragRef })}
        className="secondary vb-list-drag"
        icon="drag"
        label={props.dragLabel}
        title="拖动排序"
        disabled={props.disabled === true || props.dragDisabled === true}
      />
      <IconButton
        className="secondary"
        icon="add"
        label={props.addLabel}
        title="在后面添加"
        disabled={props.disabled === true || props.addDisabled === true}
        onClick={props.onAdd}
      />
      <IconButton
        className="secondary danger-text"
        icon="delete"
        label={props.deleteLabel}
        title="删除"
        disabled={props.disabled === true || props.deleteDisabled === true}
        onClick={props.onDelete}
      />
    </div>
  );
}
