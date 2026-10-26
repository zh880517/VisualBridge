// 与 good 模块声明同一个 editor：按 Project 顺序保留 good，本模块报 module.editorConflict 并停用。
module.exports = {
  manifest: {
    id: "visualbridge.fixture.conflict",
    version: "0.1.0",
    apiVersion: 1,
    editors: ["fixture"],
  },
  activate(host) {
    host.log("info", "fixture.conflict.activate");
    return {
      editors: [
        {
          editor: "fixture",
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
            editor: "fixture",
            describe() {
              return { title: "Conflict" };
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
          webview: "fixture",
          webviewTitle: "Conflict",
        },
      ],
    };
  },
  webviews: {
    fixture: {
      script: "(function () {})();",
      style: "",
    },
  },
};
