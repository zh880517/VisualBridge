import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { CommonIcon } from "../src/commonIcons";
import {
  EditorShell,
  EditorStatusBar,
  EditorToolbar,
  EditorToolbarGroup,
  SaveState,
  ToolbarSpacer,
} from "../src/editorChrome";
import { FeedbackSurface } from "../src/feedback";
import { InspectorPane, InspectorRail, NavigatorPane, SplitWorkspace } from "../src/layout";
import { PropertyGrid, PropertySection } from "../src/propertyLayout";
import {
  DEFAULT_SAVE_STATE_LABELS,
  appendClassName,
  joinClassNames,
  resolveSaveStateKind,
} from "../src/uiLogic";

test("class name helpers filter empty values and append optional classes", () => {
  assert.equal(joinClassNames("a", undefined, "", "b"), "a b");
  assert.equal(joinClassNames(undefined, ""), "");
  assert.equal(appendClassName("base", "extra"), "base extra");
  assert.equal(appendClassName("base", undefined), "base");
  assert.equal(appendClassName("base", ""), "base ");
});

test("save state kind prefers pending over dirty and uses stable default labels", () => {
  assert.equal(resolveSaveStateKind(true, true), "pending");
  assert.equal(resolveSaveStateKind(true, false), "dirty");
  assert.equal(resolveSaveStateKind(false, false), "saved");
  assert.deepEqual(DEFAULT_SAVE_STATE_LABELS, {
    pending: "正在应用…",
    dirty: "未保存",
    saved: "已保存",
  });
});

test("editor shell parts render their semantic elements with merged classes", () => {
  assert.match(
    renderToStaticMarkup(<EditorShell className="project-app"><span /></EditorShell>),
    /^<div class="vb-editor-shell project-app">/,
  );
  assert.match(
    renderToStaticMarkup(<EditorToolbar className="toolbar"><ToolbarSpacer /></EditorToolbar>),
    /^<header class="vb-editor-toolbar toolbar"><span class="vb-toolbar-spacer" aria-hidden="true"><\/span><\/header>$/,
  );
  assert.match(
    renderToStaticMarkup(<EditorStatusBar error className="status">x</EditorStatusBar>),
    /^<footer class="vb-editor-status error status">x<\/footer>$/,
  );
  assert.match(
    renderToStaticMarkup(<EditorToolbarGroup className="left" />),
    /^<div class="vb-toolbar-group left"><\/div>$/,
  );
});

test("SaveState exposes its kind through class and data attributes", () => {
  const dirty = renderToStaticMarkup(<SaveState dirty pending={false} />);
  assert.match(dirty, /class="vb-save-state dirty"/);
  assert.match(dirty, /data-save-state="dirty"/);
  assert.match(dirty, />未保存<\/span>$/);

  const pending = renderToStaticMarkup(<SaveState dirty pending pendingLabel="正在修改" className="extra" title="Saving" />);
  assert.match(pending, /class="vb-save-state pending extra"/);
  assert.match(pending, /data-save-state="pending"/);
  assert.match(pending, /title="Saving"/);
  assert.match(pending, />正在修改<\/span>$/);

  assert.match(renderToStaticMarkup(<SaveState dirty={false} pending={false} />), /data-save-state="saved"/);
});

test("layout and property components keep their data contract", () => {
  assert.match(
    renderToStaticMarkup(<SplitWorkspace className="workspace" />),
    /^<main class="vb-split-workspace workspace"><\/main>$/,
  );
  assert.match(renderToStaticMarkup(<NavigatorPane />), /^<aside class="vb-navigator-pane"><\/aside>$/);
  assert.match(renderToStaticMarkup(<InspectorPane />), /^<section class="vb-inspector-pane"><\/section>$/);
  assert.match(renderToStaticMarkup(<InspectorRail />), /^<div class="vb-inspector-rail"><\/div>$/);

  const grid = renderToStaticMarkup(<PropertyGrid density="sidebar" className="fields" />);
  assert.match(grid, /class="vb-fields fields"/);
  assert.match(grid, /data-density="sidebar"/);
  assert.match(renderToStaticMarkup(<PropertyGrid />), /data-density="regular"/);

  const section = renderToStaticMarkup(<PropertySection title="Transform"><span>body</span></PropertySection>);
  assert.match(section, /^<section class="vb-property-section"><h3>Transform<\/h3><span>body<\/span><\/section>$/);
  assert.doesNotMatch(renderToStaticMarkup(<PropertySection><span>body</span></PropertySection>), /<h3>/);
});

test("feedback surfaces and common icons preserve their accessibility contract", () => {
  const feedback = renderToStaticMarkup(<FeedbackSurface kind="error" className="extra">failed</FeedbackSurface>);
  assert.match(feedback, /class="vb-feedback error extra"/);
  assert.match(feedback, />failed<\/section>$/);
  assert.match(renderToStaticMarkup(<FeedbackSurface />), /class="vb-feedback notice"/);

  for (const name of ["add", "check", "close", "copy", "delete", "drag", "open", "search"] as const) {
    const markup = renderToStaticMarkup(<CommonIcon name={name} />);
    assert.match(markup, /<svg /, name);
    assert.match(markup, /class="[^"]*vb-common-icon/, name);
    assert.match(markup, /width="16"/, name);
    assert.match(markup, /height="16"/, name);
    assert.match(markup, /aria-hidden="true"/, name);
  }
});
