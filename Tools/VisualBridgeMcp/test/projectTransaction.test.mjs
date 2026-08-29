import assert from "node:assert/strict";
import test from "node:test";
import {
  ProjectTransactionConflict,
  ProjectTransactionFailure,
  withProjectTransaction,
} from "../dist/projectTransaction.js";

test("MCP keeps the Node Host Project Transaction compatibility export", () => {
  assert.equal(typeof withProjectTransaction, "function");
  assert.equal(typeof ProjectTransactionConflict, "function");
  assert.equal(typeof ProjectTransactionFailure, "function");
});
