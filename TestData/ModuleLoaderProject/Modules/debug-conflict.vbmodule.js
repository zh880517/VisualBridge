// 与 good 模块声明同一个 debug 分类：按 D.1/D.4 报 module.editorConflict 并停用。
module.exports = {
  manifest: {
    id: "visualbridge.fixture.debug-conflict",
    version: "0.1.0",
    apiVersion: 1,
    editors: ["fixture-debug"],
  },
  activate(host) {
    host.log("info", "fixture.debug-conflict.activate");
    return {
      editors: [
        {
          editor: "fixture-debug",
          storage: {
            kind: "text",
            codec: {
              parse(text) {
                return { success: true, document: { text }, diagnostics: [] };
              },
              render(document) {
                return document.text;
              },
            },
          },
          semantic: {
            editor: "fixture-debug",
            describe() {
              return { title: "Debug conflict" };
            },
            validate() {
              return [];
            },
            applyOperations(document) {
              return { success: true, document, diagnostics: [] };
            },
            collectReferences() {
              return [];
            },
            replaceReferenceValues(document) {
              return { success: true, document, diagnostics: [] };
            },
          },
          debug: {
            categories: ["fixture.debug"],
            onRecord() {
              return undefined;
            },
          },
          session: {
            createController() {
              return {
                state() {
                  return {};
                },
                async handle() {
                  return [];
                },
              };
            },
          },
          webview: "fixture-debug",
          webviewTitle: "Debug conflict",
        },
      ],
    };
  },
  webviews: {
    "fixture-debug": {
      script: "(function () {})();",
      style: "",
    },
  },
};
