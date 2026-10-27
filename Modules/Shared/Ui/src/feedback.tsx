import type { HTMLAttributes, ReactElement } from "react";

export type FeedbackKind = "empty" | "loading" | "notice" | "error";

export function FeedbackSurface(props: HTMLAttributes<HTMLElement> & {
  readonly kind?: FeedbackKind;
}): ReactElement {
  const { kind = "notice", ...elementProps } = props;
  const className = `vb-feedback ${kind}${props.className === undefined ? "" : ` ${props.className}`}`;
  return <section {...elementProps} className={className} />;
}
