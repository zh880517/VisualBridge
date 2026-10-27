import { createRoot } from "react-dom/client";
import { ReactFlowProvider } from "@xyflow/react";
// Keep the stylesheet order identical to the original single-file entry: the shared
// editor/form styles are pulled in before React Flow's base styles and the graph
// overrides, so the cascade is unchanged.
import "../../../Shared/Form/index";
import "../../../Shared/Ui/index";
import "@xyflow/react/dist/style.css";
import "./styles.css";
import { GraphEditorApp } from "./GraphEditorApp";

const rootElement = document.getElementById("root");
if (rootElement === null) {
  throw new Error("VisualBridge Graph root element was not found.");
}

createRoot(rootElement).render(<ReactFlowProvider><GraphEditorApp /></ReactFlowProvider>);
