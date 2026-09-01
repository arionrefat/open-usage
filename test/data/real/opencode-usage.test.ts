import { describe, expect, test } from "bun:test";
import {
  parseBilling,
  parseCostReport,
  parseUsageRows,
} from "../../../src/data/real/opencode-usage";

/**
 * Field names and the 1e8 cost scale come from the dashboard's own consuming
 * code: it buckets on `row.date`/`row.model`/`row.plan` and renders
 * `(cost ?? 0) / 1e8`.
 */
const COST_JS =
  '$R[7]({usage:[$R[8]={date:"2026-08-01",model:"claude-sonnet-4-5",totalCost:250000000,keyId:"key_a",plan:"sub"},' +
  '$R[9]={date:"2026-08-01",model:"gpt-5.1",totalCost:125000000,keyId:"key_a",plan:null},' +
  '$R[10]={date:"2026-08-02",model:"claude-sonnet-4-5",totalCost:100000000,keyId:"key_b",plan:"lite"}],' +
  'keys:[$R[11]={id:"key_a",displayName:"laptop",deleted:false},' +
  '$R[12]={id:"key_b",displayName:"ci",deleted:true}]});';

/**
 * Verbatim in shape from a live `usage.list` response: timestamps arrive as a
 * `new Date(...)` constructor behind a `$R[n]=` binding, and absent counts are
 * an explicit null rather than a missing key.
 */
const USAGE_JS =
  ';0x0000665f;((self.$R=self.$R||{})["server-fn:abc"]=[],($R=>$R[0]=[' +
  '$R[1]={id:"usg_01",workspaceID:"wrk_01",timeCreated:$R[2]=new Date("2026-08-17T13:04:12.000Z"),' +
  'timeUpdated:$R[3]=new Date("2026-08-17T13:04:12.776Z"),timeDeleted:null,' +
  'model:"claude-sonnet-4-5",provider:"inf-go.oa-compat",' +
  "inputTokens:1200,outputTokens:340,reasoningTokens:80,cacheReadTokens:50000," +
  'cacheWrite5mTokens:900,cacheWrite1hTokens:100,cost:31400000,keyID:"key_01",' +
  'sessionID:"ses_01",byok:false,enrichment:$R[4]={plan:"sub"}}])($R["server-fn:abc"]))';

describe("parseCostReport", () => {
  test("reads rows and keys out of serialized javascript", () => {
    const report = parseCostReport(COST_JS);
    expect(report?.rows).toHaveLength(3);
    expect(report?.rows[0]).toEqual({
      date: "2026-08-01",
      model: "claude-sonnet-4-5",
      usd: 2.5,
      keyId: "key_a",
      plan: "sub",
    });
    expect(report?.keys).toEqual([
      { id: "key_a", displayName: "laptop", isDeleted: false },
      { id: "key_b", displayName: "ci", isDeleted: true },
    ]);
  });

  test("converts hundred-millionths of a dollar, never the raw integer", () => {
    // The dashboard divides by 1e8; taking totalCost at face value would report
    // a $2.50 day as $250,000,000.
    const report = parseCostReport(COST_JS);
    expect(report?.rows.reduce((sum, row) => sum + row.usd, 0)).toBeCloseTo(4.75, 10);
  });

  test("reads the json form too", () => {
    const report = parseCostReport(
      JSON.stringify({
        usage: [{ date: "2026-08-03", model: "grok-code", totalCost: 50000000, keyId: "key_c" }],
        keys: [{ id: "key_c", displayName: "desktop", deleted: false }],
      }),
    );
    expect(report?.rows[0]?.usd).toBe(0.5);
    expect(report?.rows[0]?.plan).toBe("payg");
  });

  test("an absent or unknown plan reads as pay-as-you-go, not as a subscription", () => {
    const report = parseCostReport(COST_JS);
    expect(report?.rows.map((row) => row.plan)).toEqual(["sub", "payg", "lite"]);
  });

  test("the enclosing response object is not mistaken for a row", () => {
    // A naive brace scan would match the whole payload, which contains every
    // required key, and yield a phantom row.
    const report = parseCostReport(COST_JS);
    expect(report?.rows.every((row) => /^\d{4}-\d{2}-\d{2}$/.test(row.date))).toBe(true);
  });

  test("a month with no traffic parses as empty rather than as a failure", () => {
    // Verbatim in shape from a real quiet month. Treating this as unparseable
    // makes one idle month wipe out the whole history fetch.
    const report = parseCostReport(
      ';0x00000177;((self.$R=self.$R||{})["server-fn:abc"]=[],($R=>$R[0]={usage:$R[1]=[],' +
        'keys:$R[2]=[$R[3]={id:"key_a",displayName:"Default API Key",deleted:!1}]})($R["server-fn:abc"]))',
    );
    expect(report?.rows).toEqual([]);
    expect(report?.keys).toEqual([{ id: "key_a", displayName: "Default API Key", isDeleted: false }]);
  });

  test("reads minified booleans, which is how the wire actually spells them", () => {
    // The response carries `deleted:!1`, never `deleted:false`.
    const report = parseCostReport(
      '{usage:[],keys:[{id:"key_a",displayName:"old",deleted:!0},' +
        '{id:"key_b",displayName:"live",deleted:!1}]}',
    );
    expect(report?.keys.map((key) => key.isDeleted)).toEqual([true, false]);
  });

  test("rejects payloads with no usable rows", () => {
    expect(parseCostReport("<html>login</html>")).toBeNull();
    expect(parseCostReport(JSON.stringify({ usage: "nope" }))).toBeNull();
    // A date-shaped field alone is not a row.
    expect(parseCostReport('{date:"2026-08-01"}')).toBeNull();
  });

  test("drops rows whose date is not a calendar day", () => {
    const report = parseCostReport(
      JSON.stringify({
        usage: [
          { date: "2026-08", model: "m", totalCost: 1 },
          { date: "2026-08-04", model: "m", totalCost: 100000000 },
        ],
      }),
    );
    expect(report?.rows).toHaveLength(1);
    expect(report?.rows[0]?.usd).toBe(1);
  });
});

describe("parseUsageRows", () => {
  test("reads a session row through its nested enrichment object", () => {
    const rows = parseUsageRows(USAGE_JS);
    expect(rows).toHaveLength(1);
    expect(rows?.[0]).toEqual({
      id: "usg_01",
      sessionId: "ses_01",
      keyId: "key_01",
      atMs: Date.parse("2026-08-17T13:04:12.000Z"),
      model: "claude-sonnet-4-5",
      inputTokens: 1200,
      outputTokens: 340,
      reasoningTokens: 80,
      cacheReadTokens: 50000,
      cacheWrite5mTokens: 900,
      cacheWrite1hTokens: 100,
      usd: 0.314,
      plan: "sub",
      isByok: false,
    });
  });

  test("reads the json array form", () => {
    const rows = parseUsageRows(
      JSON.stringify([
        {
          sessionID: "ses_02",
          timeCreated: "2026-08-10T12:00:00Z",
          model: "gpt-5.1",
          inputTokens: 10,
          outputTokens: 5,
          cost: 200000000,
          byok: true,
        },
      ]),
    );
    expect(rows?.[0]?.atMs).toBe(Date.parse("2026-08-10T12:00:00Z"));
    expect(rows?.[0]?.usd).toBe(2);
    expect(rows?.[0]?.isByok).toBe(true);
    expect(rows?.[0]?.plan).toBe("payg");
  });

  test("reads a timestamp built by a Date constructor, not just a number", () => {
    // The live wire form is `timeCreated:$R[2]=new Date("...")`; a number-or-ISO
    // reader alone leaves every row undated.
    expect(parseUsageRows(USAGE_JS)?.[0]?.atMs).toBe(Date.parse("2026-08-17T13:04:12.000Z"));
  });

  test("treats an explicit null count as zero", () => {
    const rows = parseUsageRows(
      '[{model:"m",inputTokens:5,outputTokens:2,reasoningTokens:null,cacheReadTokens:null}]',
    );
    expect(rows?.[0]?.reasoningTokens).toBe(0);
    expect(rows?.[0]?.cacheReadTokens).toBe(0);
  });

  test("returns null rather than an empty page for an unusable payload", () => {
    expect(parseUsageRows("<html>login</html>")).toBeNull();
  });
});

/** Verbatim in shape from a live `billing.get` on a Go-only account. */
const BILLING_JS =
  '$R[0]={customerID:"cus_1",paymentMethodLast4:"4242",balance:0,reload:null,reloadAmount:20,' +
  "reloadAmountMin:10,reloadTrigger:5,monthlyLimit:null,monthlyUsage:null,subscription:null," +
  'subscriptionID:null,lite:$R[1]={},liteSubscriptionID:"lsub_1"}';

describe("parseBilling", () => {
  test("separates the two scales the dashboard itself uses", () => {
    // balance is hundred-millionths; reloadAmount is plain dollars. Applying one
    // scale to both misreports a $20 reload as twenty billionths of a cent.
    const billing = parseBilling(
      '{balance:250000000,reloadAmount:20,reloadTrigger:5,monthlyLimit:100,monthlyUsage:750000000}',
    );
    expect(billing?.balanceUsd).toBe(2.5);
    expect(billing?.monthlyUsageUsd).toBe(7.5);
    expect(billing?.monthlyLimitUsd).toBe(100);
    expect(billing?.reloadAmountUsd).toBe(20);
  });

  test("a go-only account reports no charges and no metered usage", () => {
    const billing = parseBilling(BILLING_JS);
    expect(billing?.balanceUsd).toBe(0);
    expect(billing?.monthlyUsageUsd).toBeNull();
    expect(billing?.monthlyLimitUsd).toBeNull();
    expect(billing?.isAutoReloadOn).toBe(false);
    expect(billing?.hasLiteSubscription).toBe(true);
    expect(billing?.hasSubscription).toBe(false);
  });

  test("reads the json form too", () => {
    const billing = parseBilling(
      JSON.stringify({ balance: 0, reload: true, reloadAmount: 20, subscription: { id: "s" } }),
    );
    expect(billing?.isAutoReloadOn).toBe(true);
    expect(billing?.hasSubscription).toBe(true);
  });

  test("rejects a payload with no billing record", () => {
    expect(parseBilling("<html>login</html>")).toBeNull();
  });
});
