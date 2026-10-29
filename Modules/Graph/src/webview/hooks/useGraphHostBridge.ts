import { useEffect, type Dispatch, type RefObject, type SetStateAction } from "react";
import {
  GRAPH_REVEAL_MESSAGE_TYPE,
  GRAPH_REVEAL_RESULT_MESSAGE_TYPE,
  readGraphRevealTarget,
  type GraphRevealPlan,
  type GraphRevealRequest,
  type GraphRevealResult,
} from "../../graphReveal";
import {
  referenceBridge,
  setWebviewToken,
  vscode,
  webviewInstanceId,
} from "../runtime";
import {
  consumeSelectionHistory,
  keepValidSelection,
  parseGraphClipboardPayload,
} from "../model/graphUtils";
import type { GraphDebugController } from "./useGraphDebug";
import type {
  DocumentDiagnostic,
  GraphCatalogRegistry,
  GraphClipboardPayload,
  GraphContextMenuState,
  GraphDocument,
  GraphFlowEdge,
  GraphFlowNode,
  HostMessage,
  NodePickerState,
  Selection,
  SelectionHistoryEntry,
} from "../types";

export interface GraphHostBridgeOptions {
  readonly debug: GraphDebugController;
  readonly updateSelection: (
    next: Selection | undefined,
    synchronizeFlow?: boolean,
    recordHistory?: boolean,
  ) => void;
  readonly pasteClipboardPayload: (payload: GraphClipboardPayload, requestedOffset?: number) => void;
  readonly documentRef: RefObject<GraphDocument | undefined>;
  readonly catalogRegistryRef: RefObject<GraphCatalogRegistry>;
  readonly catalogReadyRef: RefObject<boolean>;
  readonly activeGraphIdRef: RefObject<string>;
  readonly pendingRef: RefObject<boolean>;
  readonly selectedRef: RefObject<Selection | undefined>;
  readonly documentVersionRef: RefObject<number>;
  readonly undoSelectionHistoryRef: RefObject<SelectionHistoryEntry[]>;
  readonly redoSelectionHistoryRef: RefObject<SelectionHistoryEntry[]>;
  readonly pendingSelectionHistoryRef: RefObject<SelectionHistoryEntry | undefined>;
  readonly lastCompletedOperationVersionRef: RefObject<number | undefined>;
  readonly applyingRevealRequestIdRef: RefObject<string | undefined>;
  readonly currentRevealRequestIdRef: RefObject<string | undefined>;
  readonly revealTimerRef: RefObject<number | undefined>;
  readonly handshakeProposalSentRef: RefObject<boolean>;
  readonly autoLayoutFitViewRef: RefObject<boolean>;
  readonly setGraphDocument: Dispatch<SetStateAction<GraphDocument | undefined>>;
  readonly setCatalogRegistry: Dispatch<SetStateAction<GraphCatalogRegistry>>;
  readonly setCatalogReady: Dispatch<SetStateAction<boolean>>;
  readonly setDocumentDirty: Dispatch<SetStateAction<boolean | undefined>>;
  readonly setReplacementCandidates: Dispatch<SetStateAction<Readonly<Record<string, readonly string[]>>>>;
  readonly setActiveGraphIdValue: Dispatch<SetStateAction<string>>;
  readonly setInvalidDiagnostics: Dispatch<SetStateAction<readonly DocumentDiagnostic[]>>;
  readonly setStatus: Dispatch<SetStateAction<{ message: string; error: boolean }>>;
  readonly setContextMenu: Dispatch<SetStateAction<GraphContextMenuState | undefined>>;
  readonly setPicker: Dispatch<SetStateAction<NodePickerState | undefined>>;
  readonly setSubgraphPickerOpen: Dispatch<SetStateAction<boolean>>;
  readonly setPending: Dispatch<SetStateAction<boolean>>;
  readonly setFlowNodes: Dispatch<SetStateAction<GraphFlowNode[]>>;
  readonly setFlowEdges: Dispatch<SetStateAction<GraphFlowEdge[]>>;
  readonly setPendingRevealRequest: Dispatch<SetStateAction<GraphRevealRequest | undefined>>;
  readonly setActiveReveal: Dispatch<SetStateAction<{
    readonly request: GraphRevealRequest;
    readonly plan: GraphRevealPlan;
  } | undefined>>;
  readonly setRevealedElement: Dispatch<SetStateAction<GraphRevealPlan | undefined>>;
}

export function useGraphHostBridge({
  debug,
  updateSelection,
  pasteClipboardPayload,
  documentRef,
  catalogRegistryRef,
  catalogReadyRef,
  activeGraphIdRef,
  pendingRef,
  selectedRef,
  documentVersionRef,
  undoSelectionHistoryRef,
  redoSelectionHistoryRef,
  pendingSelectionHistoryRef,
  lastCompletedOperationVersionRef,
  applyingRevealRequestIdRef,
  currentRevealRequestIdRef,
  revealTimerRef,
  handshakeProposalSentRef,
  autoLayoutFitViewRef,
  setGraphDocument,
  setCatalogRegistry,
  setCatalogReady,
  setDocumentDirty,
  setReplacementCandidates,
  setActiveGraphIdValue,
  setInvalidDiagnostics,
  setStatus,
  setContextMenu,
  setPicker,
  setSubgraphPickerOpen,
  setPending,
  setFlowNodes,
  setFlowEdges,
  setPendingRevealRequest,
  setActiveReveal,
  setRevealedElement,
}: GraphHostBridgeOptions): void {
  const {
    applyDebugFacetReset,
    applyDebugFacetSnapshot,
    applyDebugFacetUpdates,
    debugEventsRef,
    debugFlashTimerRef,
  } = debug;

  useEffect(() => {
    const receiveMessage = (event: MessageEvent<HostMessage>): void => {
      const message = event.data;
      if (message.type === "requestReady") {
        setWebviewToken(message.webviewToken);
        // 唯一握手：`ready` 让宿主在 `onWebviewReady` 推 `debugFacetSnapshot`（G1a 的渲染源）。
        vscode.postMessage({ type: "ready", instanceId: webviewInstanceId });
        return;
      }
      if (message.type === "debugFacetReset") {
        applyDebugFacetReset();
        return;
      }
      if (message.type === "debugFacetSnapshot") {
        applyDebugFacetSnapshot(message.updates, message.state, message.truncated);
        return;
      }
      if (message.type === "debugFacetUpdate") {
        applyDebugFacetUpdates([{ seq: message.update.seq, update: message.update }]);
        return;
      }
      if (referenceBridge.handleMessage(message)) {
        return;
      }
      if (message.type === GRAPH_REVEAL_MESSAGE_TYPE) {
        const target = readGraphRevealTarget(message.target);
        if (typeof message.requestId !== "string" || target === undefined) {
          const result: GraphRevealResult = {
            type: GRAPH_REVEAL_RESULT_MESSAGE_TYPE,
            requestId: typeof message.requestId === "string" ? message.requestId : "invalid",
            found: false,
            message: "图定位请求无效。",
          };
          vscode.postMessage(result);
          return;
        }
        if (currentRevealRequestIdRef.current === message.requestId) {
          return;
        }
        currentRevealRequestIdRef.current = message.requestId;
        if (revealTimerRef.current !== undefined) {
          window.clearTimeout(revealTimerRef.current);
          revealTimerRef.current = undefined;
        }
        applyingRevealRequestIdRef.current = undefined;
        setRevealedElement(undefined);
        setActiveReveal(undefined);
        setPendingRevealRequest({ type: GRAPH_REVEAL_MESSAGE_TYPE, requestId: message.requestId, target });
        return;
      }
      if (message.type === "graphState") {
        if (message.documentChanged === true && message.historyAction === undefined) {
          const ownOperation = pendingSelectionHistoryRef.current !== undefined
            || lastCompletedOperationVersionRef.current === message.documentVersion;
          if (lastCompletedOperationVersionRef.current === message.documentVersion) {
            lastCompletedOperationVersionRef.current = undefined;
          }
          if (!ownOperation) {
            undoSelectionHistoryRef.current = [];
            redoSelectionHistoryRef.current = [];
          }
        }
        const restoredSelection = consumeSelectionHistory(
          message.historyAction,
          undoSelectionHistoryRef.current,
          redoSelectionHistoryRef.current,
        );
        documentRef.current = message.document;
        catalogRegistryRef.current = message.catalogRegistry;
        catalogReadyRef.current = message.catalogReady;
        documentVersionRef.current = message.documentVersion;
        if (pendingSelectionHistoryRef.current === undefined) {
          pendingRef.current = false;
          setPending(false);
        }
        const preferredGraphId = restoredSelection?.graphId ?? activeGraphIdRef.current;
        const currentGraphId = message.document.graphs.some((graph) => graph.id === preferredGraphId)
          ? preferredGraphId
          : message.document.rootGraphId;
        activeGraphIdRef.current = currentGraphId;
        setGraphDocument(message.document);
        setCatalogRegistry(message.catalogRegistry);
        setCatalogReady(message.catalogReady);
        setDocumentDirty(Boolean(message.isDirty));
        setReplacementCandidates({});
        setActiveGraphIdValue(currentGraphId);
        setInvalidDiagnostics([]);
        setContextMenu(undefined);
        if (!message.catalogReady) {
          setPicker(undefined);
          setSubgraphPickerOpen(false);
        }

        const currentGraph = message.document.graphs.find((graph) => graph.id === currentGraphId);
        const requestedSelection = restoredSelection?.selection ?? selectedRef.current;
        const nextSelection = currentGraph === undefined
          ? undefined
          : keepValidSelection(requestedSelection, currentGraph);
        updateSelection(nextSelection, true, false);
        const firstError = message.diagnostics.find((diagnostic) => diagnostic.severity === "error");
        const firstWarning = message.diagnostics.find((diagnostic) => diagnostic.severity === "warning");
        const firstDiagnostic = firstError ?? firstWarning;
        setStatus(firstDiagnostic === undefined
          ? message.catalogReady
            ? { message: "就绪", error: false }
            : { message: "目录尚未就绪，已禁用依赖目录的编辑操作。", error: true }
          : { message: `${firstDiagnostic.path}: ${firstDiagnostic.message}`, error: firstError !== undefined || !message.catalogReady });
        return;
      }
      if (message.type === "replacementCandidates") {
        if (
          message.documentVersion === documentVersionRef.current
          && message.graphId === activeGraphIdRef.current
        ) {
          setReplacementCandidates((current) => ({ ...current, [message.nodeId]: message.nodeTypeIds }));
        }
        return;
      }
      if (message.type === "clipboardData") {
        const payload = parseGraphClipboardPayload(message.text);
        if (payload === undefined) {
          setStatus({ message: "剪贴板中没有有效的 VisualBridge 图节点数据。", error: true });
        } else {
          pasteClipboardPayload(payload);
        }
        return;
      }
      if (message.type === "operationCompleted") {
        const pendingEntry = pendingSelectionHistoryRef.current;
        pendingSelectionHistoryRef.current = undefined;
        pendingRef.current = false;
        setPending(false);
        if (!message.changed) {
          // 布局为 no-op（位置未变化）时不需要 fitView。
          autoLayoutFitViewRef.current = false;
        }
        if (message.changed && pendingEntry !== undefined) {
          undoSelectionHistoryRef.current.push(pendingEntry);
          redoSelectionHistoryRef.current = [];
          lastCompletedOperationVersionRef.current = message.documentVersion;
        }
        return;
      }
      if (message.type === "graphInvalid") {
        if (message.documentChanged === true && message.historyAction === undefined) {
          const ownOperation = pendingSelectionHistoryRef.current !== undefined
            || lastCompletedOperationVersionRef.current === message.documentVersion;
          if (!ownOperation) {
            undoSelectionHistoryRef.current = [];
            redoSelectionHistoryRef.current = [];
          }
        }
        consumeSelectionHistory(
          message.historyAction,
          undoSelectionHistoryRef.current,
          redoSelectionHistoryRef.current,
        );
        documentRef.current = undefined;
        catalogReadyRef.current = false;
        documentVersionRef.current = message.documentVersion;
        pendingRef.current = false;
        autoLayoutFitViewRef.current = false;
        updateSelection(undefined, true, false);
        setGraphDocument(undefined);
        setCatalogReady(false);
        setDocumentDirty(Boolean(message.isDirty));
        setFlowNodes([]);
        setFlowEdges([]);
        setPending(false);
        setInvalidDiagnostics(message.diagnostics);
        setStatus({ message: "图文档解析失败。", error: true });
        return;
      }
      if (message.type === "operationRejected") {
        const rejectedEntry = pendingSelectionHistoryRef.current;
        pendingSelectionHistoryRef.current = undefined;
        if (rejectedEntry !== undefined) {
          activeGraphIdRef.current = rejectedEntry.before.graphId;
          setActiveGraphIdValue(rejectedEntry.before.graphId);
          updateSelection(rejectedEntry.before.selection, true, false);
        }
        pendingRef.current = false;
        setPending(false);
        autoLayoutFitViewRef.current = false;
        setStatus({ message: message.message, error: true });
      }
    };
    window.addEventListener("message", receiveMessage);
    if (!handshakeProposalSentRef.current) {
      handshakeProposalSentRef.current = true;
      setWebviewToken(undefined);
      vscode.postMessage({ type: "ready", instanceId: webviewInstanceId });
    }
    return () => {
      window.removeEventListener("message", receiveMessage);
      if (revealTimerRef.current !== undefined) {
        window.clearTimeout(revealTimerRef.current);
      }
      if (debugFlashTimerRef.current !== undefined) {
        window.clearTimeout(debugFlashTimerRef.current);
      }
      referenceBridge.dispose();
    };
  }, [
    activeGraphIdRef,
    applyDebugFacetReset,
    applyDebugFacetSnapshot,
    applyDebugFacetUpdates,
    applyingRevealRequestIdRef,
    autoLayoutFitViewRef,
    catalogReadyRef,
    catalogRegistryRef,
    currentRevealRequestIdRef,
    debugEventsRef,
    debugFlashTimerRef,
    documentRef,
    documentVersionRef,
    handshakeProposalSentRef,
    lastCompletedOperationVersionRef,
    pasteClipboardPayload,
    pendingRef,
    pendingSelectionHistoryRef,
    redoSelectionHistoryRef,
    revealTimerRef,
    selectedRef,
    setActiveGraphIdValue,
    setActiveReveal,
    setCatalogReady,
    setCatalogRegistry,
    setContextMenu,
    setDocumentDirty,
    setFlowEdges,
    setFlowNodes,
    setGraphDocument,
    setInvalidDiagnostics,
    setPending,
    setPendingRevealRequest,
    setPicker,
    setReplacementCandidates,
    setRevealedElement,
    setStatus,
    setSubgraphPickerOpen,
    undoSelectionHistoryRef,
    updateSelection,
  ]);
}
