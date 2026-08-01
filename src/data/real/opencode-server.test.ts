import { describe, expect, test } from "bun:test";
import {
  filterCookieHeader,
  isSignedOut,
  parseSubscription,
  parseWorkspaceId,
} from "./opencode-server";

/** Verbatim response shapes from CodexBar's parser fixtures. */
const WORKSPACE_JS =
  ';0x00000089;((self.$R=self.$R||{})["codexbar"]=[],' +
  '($R=>$R[0]=[$R[1]={id:"wrk_01K6AR1ZET89H8NB691FQ2C2VB",name:"Default",slug:null}])' +
  '($R["codexbar"]))';

const SUBSCRIPTION_JS =
  "$R[16]($R[30],$R[41]={" +
  'rollingUsage:$R[42]={status:"ok",resetInSec:5944,usagePercent:17},' +
  'weeklyUsage:$R[43]={status:"ok",resetInSec:278201,usagePercent:75}' +
  "});";

describe("parseWorkspaceId", () => {
  test("finds the workspace id in serialized javascript", () => {
    expect(parseWorkspaceId(WORKSPACE_JS)).toBe("wrk_01K6AR1ZET89H8NB691FQ2C2VB");
  });

  test("returns null when no workspace is present", () => {
    expect(parseWorkspaceId('{"workspaces":[]}')).toBeNull();
  });
});

describe("parseSubscription", () => {
  test("reads both windows out of serialized javascript", () => {
    const parsed = parseSubscription(SUBSCRIPTION_JS);
    expect(parsed?.rolling).toEqual({ percent: 17, resetInSec: 5944 });
    expect(parsed?.weekly).toEqual({ percent: 75, resetInSec: 278201 });
  });

  test("reads the json form too", () => {
    const parsed = parseSubscription(
      JSON.stringify({
        rollingUsage: { usagePercent: 17, resetInSec: 5944 },
        weeklyUsage: { usagePercent: 75, resetInSec: 278201 },
      }),
    );
    expect(parsed?.rolling.percent).toBe(17);
    expect(parsed?.weekly?.percent).toBe(75);
  });

  test("reads small percentages literally instead of rescaling them", () => {
    // usagePercent is a 0-100 field, so 1 means 1%. Treating values at or under
    // 1 as fractions would show a just-reset account as fully capped.
    const parsed = parseSubscription(
      JSON.stringify({
        rollingUsage: { usagePercent: 1, resetInSec: 600 },
        weeklyUsage: { usagePercent: 0.5, resetInSec: 3600 },
      }),
    );
    expect(parsed?.rolling.percent).toBe(1);
    expect(parsed?.weekly?.percent).toBe(0.5);
  });

  test("clamps out-of-range percentages", () => {
    const parsed = parseSubscription(
      JSON.stringify({ rollingUsage: { usagePercent: 140, resetInSec: 600 } }),
    );
    expect(parsed?.rolling.percent).toBe(100);
  });

  test("computes a percent from used and limit when none is published", () => {
    const parsed = parseSubscription(
      JSON.stringify({ rollingUsage: { used: 25, limit: 100, resetInSec: 600 } }),
    );
    expect(parsed?.rolling.percent).toBe(25);
  });

  test("tolerates a missing weekly window but requires the rolling one", () => {
    const weeklyless = parseSubscription(
      JSON.stringify({ rollingUsage: { usagePercent: 17, resetInSec: 5944 } }),
    );
    expect(weeklyless?.weekly).toBeNull();

    expect(parseSubscription(JSON.stringify({ weeklyUsage: { usagePercent: 5 } }))).toBeNull();
    expect(parseSubscription("null")).toBeNull();
    expect(parseSubscription("<html>login</html>")).toBeNull();
  });

  test("does not read one window's reset into the other", () => {
    // A bare `resetInSec` scan would hand the rolling value to weekly.
    const parsed = parseSubscription(
      "rollingUsage:{resetInSec:100,usagePercent:10},weeklyUsage:{usagePercent:20}",
    );
    expect(parsed?.rolling.resetInSec).toBe(100);
    expect(parsed?.weekly).toBeNull();
  });

  test("a back-referenced window does not absorb the next window's values", () => {
    // The serializer emits a repeated object as a bare `$R[n]` with no literal;
    // scanning onward would silently give rolling the weekly figures.
    const parsed = parseSubscription(
      "$R[16]($R[30],$R[41]={rollingUsage:$R[42]," +
        'weeklyUsage:$R[43]={status:"ok",resetInSec:278201,usagePercent:75}});',
    );
    expect(parsed).toBeNull();
  });

  test("still reads a window bound through $R[n]=", () => {
    const parsed = parseSubscription(
      'rollingUsage:$R[42]={status:"ok",resetInSec:5944,usagePercent:17}',
    );
    expect(parsed?.rolling).toEqual({ percent: 17, resetInSec: 5944 });
  });
});

describe("filterCookieHeader", () => {
  test("keeps only the auth cookies", () => {
    expect(filterCookieHeader("ph_session=abc; auth=tok123; _ga=x")).toBe("auth=tok123");
    expect(filterCookieHeader("__Host-auth=tok; other=1")).toBe("__Host-auth=tok");
  });

  test("returns null when nothing authenticates", () => {
    expect(filterCookieHeader("_ga=x; ph_session=abc")).toBeNull();
    expect(filterCookieHeader("")).toBeNull();
  });
});

describe("isSignedOut", () => {
  test("detects the lapsed-session responses", () => {
    expect(isSignedOut('actor of type "public"')).toBe(true);
    expect(isSignedOut("redirecting to /auth/authorize")).toBe(true);
    expect(isSignedOut(SUBSCRIPTION_JS)).toBe(false);
  });
});
