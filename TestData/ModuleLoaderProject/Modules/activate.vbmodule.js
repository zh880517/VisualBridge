// activate 抛错：module.activateFailed。
module.exports = {
  manifest: {
    id: "visualbridge.fixture.activate",
    version: "0.1.0",
    apiVersion: 1,
    editors: ["fixture-activate"],
  },
  activate() {
    throw new Error("activate exploded");
  },
  webviews: {},
};
