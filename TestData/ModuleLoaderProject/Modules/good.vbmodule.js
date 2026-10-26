// 正常模块：提供 fixture editor、一个 Reference kind、validateOptions 与 dispose。
module.exports = {
  manifest: {
    id: "visualbridge.fixture.good",
    version: "0.1.0",
    apiVersion: 1,
    sdkVersion: "0.1.0",
    editors: ["fixture"],
  },
  activate(host) {
    host.log("info", "fixture.good.activate");
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
              return { title: "Fixture" };
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
          webview: "fixture",
          webviewTitle: "Fixture",
        },
      ],
      validateOptions(options) {
        return options && options.bad
          ? [{ severity: "error", code: "fixture.badOption", path: "$", message: "bad option value" }]
          : [];
      },
      dispose() {
        host.log("info", "fixture.good.dispose");
      },
    };
  },
  webviews: {
    fixture: {
      script: "(function () {})();",
      style: ":root { --vb-fixture: 1; }",
    },
  },
};
