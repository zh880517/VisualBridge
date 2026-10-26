// 模块 validateOptions 抛错：module.callFailed。
module.exports = {
  manifest: {
    id: "visualbridge.fixture.call",
    version: "0.1.0",
    apiVersion: 1,
    editors: ["fixture-call"],
  },
  activate(host) {
    host.log("info", "fixture.call.activate");
    return {
      editors: [
        {
          editor: "fixture-call",
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
            editor: "fixture-call",
            describe() {
              return { title: "Call" };
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
          webview: "fixture-call",
          webviewTitle: "Call",
        },
      ],
      validateOptions() {
        throw new Error("validateOptions exploded");
      },
    };
  },
  webviews: {
    "fixture-call": {
      script: "(function () {})();",
      style: "",
    },
  },
};
