// 正常模块：提供 fixture editor、一个 Reference kind、validateOptions 与 dispose。
// 调试 facet 刻意做成**有状态**的：D.4 把 `onRecord` 定义成方法，宿主必须 bind 到模块导出的
// 这个 facet 对象上，否则状态会静默落在装载器的投影副本上（F4 P2-4）。
const debugFacet = {
  categories: ["fixture.debug"],
  calls: 0,
  onRecord() {
    this.calls += 1;
    return { calls: this.calls, self: this === debugFacet };
  },
};

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
          debug: debugFacet,
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
