import assert from "node:assert/strict";
import test from "node:test";
import { TableRevealMailbox, chooseReadyTableRevealRecipient } from "../src/tableReveal";

test("Table reveal mailbox retains only the latest request until acknowledged", () => {
  const mailbox = new TableRevealMailbox();
  const first = mailbox.enqueue({ sheetId: "skills:Skills_Main", rowId: "Skills_Main:key-n:101" });

  assert.equal(mailbox.deliverable, undefined);
  assert.deepEqual(mailbox.pendingTarget, first.target);

  mailbox.markReady();
  assert.equal(deliveryRequestId(mailbox), first.requestId);

  mailbox.markUnavailable();
  assert.equal(mailbox.deliverable, undefined);
  mailbox.markReady();
  assert.equal(deliveryRequestId(mailbox), first.requestId);

  const second = mailbox.enqueue({ sheetId: "skills:Skills_Main", rowId: "Skills_Main:key-n:102" });
  assert.notEqual(second.requestId, first.requestId);
  assert.equal(mailbox.acknowledge(first.requestId), false);
  assert.equal(deliveryRequestId(mailbox), second.requestId);
  assert.equal(mailbox.acknowledge(second.requestId), true);
  assert.equal(mailbox.deliverable, undefined);
  assert.equal(mailbox.pendingTarget, undefined);
});

test("Table reveal mailbox cancellation prevents a superseded request from returning", () => {
  const mailbox = new TableRevealMailbox();
  const stale = mailbox.enqueue({ sheetId: "skills:Skills_Main", rowId: "Skills_Main:key-n:100" });
  mailbox.markReady();

  mailbox.cancel();

  assert.equal(mailbox.deliverable, undefined);
  assert.equal(mailbox.pendingTarget, undefined);
  assert.equal(mailbox.acknowledge(stale.requestId), false);
});

test("Table reveal handoff selects a ready panel without another pending request", () => {
  const closingMailbox = new TableRevealMailbox();
  const replacementMailbox = new TableRevealMailbox();
  const busyMailbox = new TableRevealMailbox();
  const target = { sheetId: "skills:Skills_Main", rowId: "Skills_Main:key-n:103" };
  closingMailbox.enqueue(target);
  replacementMailbox.markReady();
  busyMailbox.markReady();
  busyMailbox.enqueue({ sheetId: "skills:Skills_Main", rowId: "Skills_Main:key-n:104" });

  const recipient = chooseReadyTableRevealRecipient([
    { value: "busy", mailbox: busyMailbox, active: true, visible: true },
    { value: "replacement", mailbox: replacementMailbox, active: false, visible: true },
  ]);

  assert.equal(recipient, "replacement");
  replacementMailbox.enqueue(target);
  assert.deepEqual(replacementMailbox.deliverable?.target, target);
});

function deliveryRequestId(mailbox: TableRevealMailbox): string | undefined {
  return mailbox.deliverable?.requestId;
}
