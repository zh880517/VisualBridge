// manifest.editors 不是字符串数组：module.manifestInvalid。
module.exports = {
  manifest: {
    id: "visualbridge.fixture.manifest",
    version: "0.1.0",
    apiVersion: 1,
    editors: "fixture-manifest",
  },
  activate() {
    return { editors: [] };
  },
  webviews: {},
};
