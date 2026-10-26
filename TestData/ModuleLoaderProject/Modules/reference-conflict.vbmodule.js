// 与 good 模块声明同一个 Reference kind：本模块报 module.referenceKindConflict 并停用。
module.exports = {
  manifest: {
    id: "visualbridge.fixture.reference-conflict",
    version: "0.1.0",
    apiVersion: 1,
    editors: ["fixture-ref"],
  },
  activate(host) {
    host.log("info", "fixture.reference-conflict.activate");
    return {
      editors: [
        {
          editor: "fixture-ref",
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
            editor: "fixture-ref",
            describe() {
              return { title: "Reference conflict" };
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
          references: [
            {
              kind: "fixture.asset",
              createProvider() {
                return {
                  kind: "fixture.asset",
                  async search() {
                    return [];
                  },
                  async resolve() {
                    return [];
                  },
                };
              },
            },
          ],
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
          webview: "fixture-ref",
          webviewTitle: "Reference conflict",
        },
      ],
    };
  },
  webviews: {
    "fixture-ref": {
      script: "(function () {})();",
      style: "",
    },
  },
};
