// 模块 validateOptions 返回 error：module.optionsInvalid，模块停用。
module.exports = {
  manifest: {
    id: "visualbridge.fixture.options",
    version: "0.1.0",
    apiVersion: 1,
    editors: ["fixture-options"],
  },
  activate(host) {
    host.log("info", "fixture.options.activate");
    return {
      editors: [
        {
          editor: "fixture-options",
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
            editor: "fixture-options",
            describe() {
              return { title: "Options" };
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
          webview: "fixture-options",
          webviewTitle: "Options",
        },
      ],
      validateOptions(options) {
        return options && options.bad
          ? [{ severity: "error", code: "fixture.badOption", path: "$", message: "bad option value" }]
          : [];
      },
    };
  },
  webviews: {
    "fixture-options": {
      script: "(function () {})();",
      style: "",
    },
  },
};
