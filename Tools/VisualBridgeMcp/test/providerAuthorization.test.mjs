import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import {
  PROVIDER_ALLOWLIST_ENV,
  PROVIDER_ENABLED_ENV,
  ProjectProviderAuthorizationError,
  readProjectProviderAuthorization,
} from "../dist/providerAuthorization.js";

test("MCP Project Providers are disabled by default and cannot be enabled by tool input", () => {
  assert.deepEqual(readProjectProviderAuthorization({}), {
    enabled: false,
    allowedEntryPaths: [],
  });
  assert.deepEqual(readProjectProviderAuthorization({
    [PROVIDER_ENABLED_ENV]: "0",
    [PROVIDER_ALLOWLIST_ENV]: JSON.stringify([path.resolve("ignored-provider.mjs")]),
  }), {
    enabled: false,
    allowedEntryPaths: [],
  });
});

test("MCP Project Provider authorization requires an explicit strict absolute allowlist", () => {
  const entry = path.resolve("Providers", "sample-provider.mjs");
  assert.deepEqual(readProjectProviderAuthorization({
    [PROVIDER_ENABLED_ENV]: "1",
    [PROVIDER_ALLOWLIST_ENV]: JSON.stringify([entry]),
  }), {
    enabled: true,
    allowedEntryPaths: [entry],
  });

  const invalidEnvironments = [
    { [PROVIDER_ENABLED_ENV]: "true" },
    { [PROVIDER_ENABLED_ENV]: "1" },
    { [PROVIDER_ENABLED_ENV]: "1", [PROVIDER_ALLOWLIST_ENV]: "not-json" },
    { [PROVIDER_ENABLED_ENV]: "1", [PROVIDER_ALLOWLIST_ENV]: "[]" },
    { [PROVIDER_ENABLED_ENV]: "1", [PROVIDER_ALLOWLIST_ENV]: JSON.stringify(["relative/provider.mjs"]) },
    { [PROVIDER_ENABLED_ENV]: "1", [PROVIDER_ALLOWLIST_ENV]: JSON.stringify([entry, entry]) },
  ];
  invalidEnvironments.forEach((environment) => {
    assert.throws(
      () => readProjectProviderAuthorization(environment),
      ProjectProviderAuthorizationError,
    );
  });
});
