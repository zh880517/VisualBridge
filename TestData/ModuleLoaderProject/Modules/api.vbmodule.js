// apiVersion 与宿主不一致：module.apiVersionMismatch，停用。
module.exports = {
  manifest: {
    id: "visualbridge.fixture.api",
    version: "0.1.0",
    apiVersion: 999,
    editors: ["fixture-api"],
  },
  activate() {
    return { editors: [] };
  },
  webviews: {},
};
