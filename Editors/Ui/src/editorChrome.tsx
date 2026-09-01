import type { HTMLAttributes, ReactElement, ReactNode } from "react";

function joinClassNames(...values: readonly (string | undefined)[]): string {
  return values.filter((value): value is string => value !== undefined && value.length > 0).join(" ");
}

export function EditorShell(props: HTMLAttributes<HTMLDivElement>): ReactElement {
  return <div {...props} className={joinClassNames("vb-editor-shell", props.className)} />;
}

export function EditorToolbar(props: HTMLAttributes<HTMLElement>): ReactElement {
  return <header {...props} className={joinClassNames("vb-editor-toolbar", props.className)} />;
}

export function EditorStatusBar(props: HTMLAttributes<HTMLElement> & {
  readonly error?: boolean;
}): ReactElement {
  const { error, ...elementProps } = props;
  return (
    <footer
      {...elementProps}
      className={joinClassNames("vb-editor-status", error === true ? "error" : undefined, props.className)}
    />
  );
}

export function ToolbarSpacer(): ReactElement {
  return <span className="vb-toolbar-spacer" aria-hidden="true" />;
}

export function EditorToolbarGroup(props: HTMLAttributes<HTMLDivElement>): ReactElement {
  return <div {...props} className={joinClassNames("vb-toolbar-group", props.className)} />;
}

export function SaveState(props: {
  readonly dirty: boolean;
  readonly pending: boolean;
  readonly savedLabel?: ReactNode;
  readonly dirtyLabel?: ReactNode;
  readonly pendingLabel?: ReactNode;
  readonly className?: string;
  readonly title?: string;
}): ReactElement {
  const kind = props.pending ? "pending" : props.dirty ? "dirty" : "saved";
  const label = props.pending
    ? (props.pendingLabel ?? "正在应用…")
    : props.dirty
      ? (props.dirtyLabel ?? "未保存")
      : (props.savedLabel ?? "已保存");
  return (
    <span className={joinClassNames("vb-save-state", kind, props.className)} data-save-state={kind} title={props.title}>
      <i aria-hidden="true" />
      {label}
    </span>
  );
}
