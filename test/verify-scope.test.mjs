import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMcpHarness, assertToolOk } from "./support/mcp-harness.mjs";

// Rows older than the 90-day verification window used to cost one GET each,
// before the write (undo snapshot) and after it (verification).
const perRowGets = (fake, id) => fake.requests.filter((r) => r.method === "GET" && r.path.endsWith(`/transactions/${id}`)).length;

test("reconciling an old row with scope uses account-scoped lists, not per-row GETs", async (t) => {
  const harness = await createMcpHarness(); t.after(() => harness.close());
  const result = await harness.write("update_transactions", {
    transactions: [{ id: "fake-old", cleared: "reconciled" }],
    scope: { accountId: "fake-checking", sinceDate: "2019-01-01", untilDate: "2019-12-31" },
    returnSummary: true,
  });
  const data = assertToolOk(result);
  assert.equal(data.verification.failed, 0);
  assert.equal(perRowGets(harness.fake, "fake-old"), 0);
  assert.ok(harness.fake.requests.some((r) => r.method === "GET" && r.path.endsWith("/accounts/fake-checking/transactions") && r.query.since_date === "2019-01-10"),
    "post-write verification should refetch the row's account and date range");
  assert.equal(harness.fake.budget().transactions.find((row) => row.id === "fake-old").cleared, "reconciled");
});

test("transactionsFile contents are bound into the preview; editing the file after approval is rejected", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ynab-synthetic-txfile-")); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "batch.json");
  writeFileSync(file, JSON.stringify([{ id: "fake-import", cleared: "reconciled" }]));
  const harness = await createMcpHarness({ localFiles: true }); t.after(() => harness.close());

  const { data: plan, previewToken } = await harness.preview("update_transactions", { transactionsFile: file });
  assert.ok(JSON.stringify(plan).includes("fake-import"), "preview must show the file's rows");

  writeFileSync(file, JSON.stringify([{ id: "fake-uncertain", cleared: "reconciled" }]));
  const stale = await harness.call("update_transactions", { transactionsFile: file, previewToken, confirmed: true });
  assert.equal(stale.isError, true);
  assert.match(stale.content[0].text, /Stale preview/);
  assert.equal(harness.fake.writes().length, 0);

  const fresh = await harness.write("update_transactions", { transactionsFile: file, returnSummary: true });
  assertToolOk(fresh);
  assert.equal(harness.fake.budget().transactions.find((row) => row.id === "fake-uncertain").cleared, "reconciled");
  assert.equal(harness.fake.budget().transactions.find((row) => row.id === "fake-import").cleared, "cleared");
});

test("transactionsFile is unavailable unless the server enables local files", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ynab-synthetic-txfile-")); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "batch.json");
  writeFileSync(file, JSON.stringify([{ id: "fake-import", cleared: "reconciled" }]));
  const harness = await createMcpHarness(); t.after(() => harness.close());

  const { tools } = await harness.client.listTools();
  const schema = tools.find((tool) => tool.name === "update_transactions").inputSchema;
  assert.equal(schema.properties.transactionsFile, undefined);
  const result = await harness.client.callTool({ name: "preview_write_tool", arguments: { tool_name: "update_transactions", input: { transactionsFile: file } } });
  assert.equal(result.isError, true);
  assert.equal(harness.fake.writes().length, 0);
});

test("occurrences of one scheduled transaction (uuid_YYYY-MM-DD) are distinct rows in a batch", async (t) => {
  const harness = await createMcpHarness(); t.after(() => harness.close());
  const rows = harness.fake.budget().transactions;
  const base = { account_id: "fake-checking", payee_id: "fake-market", category_id: "fake-food", approved: true, cleared: "cleared", deleted: false, memo: null, subtransactions: [], _knowledge: 1 };
  rows.push({ ...base, id: "fake-sched_2019-02-15", date: "2019-02-15", amount: -1000 });
  rows.push({ ...base, id: "fake-sched_2019-03-15", date: "2019-03-15", amount: -2000 });

  const result = await harness.write("update_transactions", {
    transactions: [{ id: "fake-sched_2019-02-15", cleared: "reconciled" }, { id: "fake-sched_2019-03-15", cleared: "reconciled" }],
    scope: { accountId: "fake-checking", sinceDate: "2019-01-01" },
    returnSummary: true,
  });
  const data = assertToolOk(result);
  assert.equal(data.verification.failed, 0);
  assert.deepEqual(rows.filter((r) => r.id.startsWith("fake-sched_")).map((r) => r.cleared), ["reconciled", "reconciled"]);
  assert.equal(harness.fake.requests.filter((r) => r.method === "GET" && /\/transactions\/fake-sched/.test(r.path)).length, 0);
});

test("get_transaction reads a realized scheduled occurrence by its full composite id", async (t) => {
  const harness = await createMcpHarness(); t.after(() => harness.close());
  harness.fake.budget().transactions.push({ id: "fake-sched_2019-04-15", date: "2019-04-15", amount: -3000, account_id: "fake-checking", payee_id: "fake-market", category_id: "fake-food", approved: true, cleared: "cleared", deleted: false, memo: null, subtransactions: [], _knowledge: 1 });
  const data = assertToolOk(await harness.call("get_transaction", { transactionId: "fake-sched_2019-04-15" }));
  assert.equal(data.id, "fake-sched_2019-04-15");
  assert.equal(data.amount, -3);
});

process.env.YNAB_MCP_NO_AUTOSTART = "1";
const { accountDateScopes, readTransactionsFile } = await import("../index.js");

test("accountDateScopes groups rows by account with min/max dates", () => {
  assert.deepEqual(
    accountDateScopes([
      { account_id: "a", date: "2025-06-10" },
      { account_id: "b", date: "2025-01-01" },
      { account_id: "a", date: "2025-05-09" },
      { account_id: "a", date: "2025-08-18" },
      { date: "2025-01-01" },
    ]),
    [
      { accountId: "a", sinceDate: "2025-05-09", untilDate: "2025-08-18" },
      { accountId: "b", sinceDate: "2025-01-01", untilDate: "2025-01-01" },
    ],
  );
});

test("readTransactionsFile validates path, JSON and schema without echoing contents", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ynab-synthetic-txfile-")); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const good = join(dir, "good.json");
  writeFileSync(good, JSON.stringify([{ id: "t1", cleared: "reconciled" }]));
  assert.deepEqual(readTransactionsFile(good), [{ id: "t1", cleared: "reconciled" }]);

  assert.throws(() => readTransactionsFile("relative.json"), /absolute path to a \.json file/);
  assert.throws(() => readTransactionsFile(join(dir, "x.txt")), /absolute path to a \.json file/);
  assert.throws(() => readTransactionsFile(join(dir, "missing.json")), /Could not read transactionsFile/);
  const secret = join(dir, "bad.json");
  writeFileSync(secret, "SYNTHETIC-SECRET not json");
  assert.throws(() => readTransactionsFile(secret), (err) => /is not valid JSON/.test(err.message) && !err.message.includes("SYNTHETIC-SECRET"));
  const shape = join(dir, "shape.json");
  writeFileSync(shape, JSON.stringify([{ id: "t1", cleared: "done" }]));
  assert.throws(() => readTransactionsFile(shape), /failed validation: 0\.cleared/);
  const empty = join(dir, "empty.json");
  writeFileSync(empty, "[]");
  assert.throws(() => readTransactionsFile(empty), /failed validation/);
});
