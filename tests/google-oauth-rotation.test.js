import assert from "node:assert/strict";
import test from "node:test";
import { beginGooglePlannerAuthorization, googlePlannerScopes, replaceEnvironmentAssignment } from "../src/google-oauth-rotation.js";

test("Google planner authorization requests Calendar write and Tasks scopes", () => {
  assert.deepEqual(googlePlannerScopes, [
    "https://www.googleapis.com/auth/calendar",
    "https://www.googleapis.com/auth/tasks"
  ]);
});

test("replaces only the selected protected environment assignment", () => {
  const updated = replaceEnvironmentAssignment("ONE=1\nGOOGLE_CALENDAR_REFRESH_TOKEN=old\nTWO=2\n", "GOOGLE_CALENDAR_REFRESH_TOKEN", "new-token");
  assert.equal(updated, "ONE=1\nGOOGLE_CALENDAR_REFRESH_TOKEN=new-token\nTWO=2\n");
  assert.throws(() => replaceEnvironmentAssignment("", "GOOGLE_CALENDAR_REFRESH_TOKEN", "two\nlines"), /single non-empty line/);
});
