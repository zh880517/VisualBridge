import type { HTMLAttributes, ReactElement, ReactNode } from "react";
import {
  DEFAULT_SAVE_STATE_LABELS,
  joinClassNames,
  resolveSaveStateKind,
} from "./uiLogic";

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
  const kind = resolveSaveStateKind(props.dirty, props.pending);
  const label = kind === "pending"
    ? (props.pendingLabel ?? DEFAULT_SAVE_STATE_LABELS.pending)
    : kind === "dirty"
      ? (props.dirtyLabel ?? DEFAULT_SAVE_STATE_LABELS.dirty)
      : (props.savedLabel ?? DEFAULT_SAVE_STATE_LABELS.saved);
  return (
    <span className={joinClassNames("vb-save-state", kind, props.className)} data-save-state={kind} title={props.title}>
      <i aria-hidden="true" />
      {label}
    </span>
  );
}
