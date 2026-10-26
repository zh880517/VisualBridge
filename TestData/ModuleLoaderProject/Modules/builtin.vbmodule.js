// require("fs") 是 Node 内置模块，必须放行。
const fs = require("fs");

module.exports = {
  manifest: {
    id: "visualbridge.fixture.builtin",
    version: "0.1.0",
    apiVersion: 1,
    editors: ["fixture-builtin"],
  },
  activate(host) {
    host.log("info", `fixture.builtin.activate:${typeof fs.readFileSync}`);
    return {
      editors: [
        {
          editor: "fixture-builtin",
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
            editor: "fixture-builtin",
            describe() {
              return { title: "Builtin" };
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
          webview: "fixture-builtin",
          webviewTitle: "Builtin",
        },
      ],
    };
  },
  webviews: {
    "fixture-builtin": {
      script: "(function () {})();",
      style: "",
    },
  },
};
