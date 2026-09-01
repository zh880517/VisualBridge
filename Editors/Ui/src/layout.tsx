import type { HTMLAttributes, ReactElement } from "react";

function classes(base: string, extra: string | undefined): string {
  return extra === undefined ? base : `${base} ${extra}`;
}

export function SplitWorkspace(props: HTMLAttributes<HTMLElement>): ReactElement {
  return <main {...props} className={classes("vb-split-workspace", props.className)} />;
}

export function NavigatorPane(props: HTMLAttributes<HTMLElement>): ReactElement {
  return <aside {...props} className={classes("vb-navigator-pane", props.className)} />;
}

export function InspectorPane(props: HTMLAttributes<HTMLElement>): ReactElement {
  return <section {...props} className={classes("vb-inspector-pane", props.className)} />;
}

export function InspectorRail(props: HTMLAttributes<HTMLDivElement>): ReactElement {
  return <div {...props} className={classes("vb-inspector-rail", props.className)} />;
}
