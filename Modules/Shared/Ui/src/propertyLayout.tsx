import type { HTMLAttributes, ReactElement } from "react";

export type PropertyDensity = "regular" | "sidebar" | "compact";

export function PropertyGrid(props: HTMLAttributes<HTMLDivElement> & {
  readonly density?: PropertyDensity;
}): ReactElement {
  const { density = "regular", ...elementProps } = props;
  return <div {...elementProps} className={`vb-fields${props.className === undefined ? "" : ` ${props.className}`}`} data-density={density} />;
}

export function PropertySection(props: HTMLAttributes<HTMLElement> & {
  readonly title?: string;
}): ReactElement {
  const { title, children, ...elementProps } = props;
  return (
    <section {...elementProps} className={`vb-property-section${props.className === undefined ? "" : ` ${props.className}`}`}>
      {title === undefined ? null : <h3>{title}</h3>}
      {children}
    </section>
  );
}
