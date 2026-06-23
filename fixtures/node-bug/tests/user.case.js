import test from "node:test";
import assert from "node:assert/strict";
import { fullName } from "../src/user.js";

test("fullName formats a user", () => {
  assert.equal(fullName({ firstName: "Ada", lastName: "Lovelace" }), "Ada Lovelace");
});
