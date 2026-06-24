const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

test("UserService is discoverable as a Spring service", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "main", "java", "com", "example", "UserService.java"), "utf8");
  assert.match(source, /import\s+org\.springframework\.stereotype\.Service;/);
  assert.match(source, /@Service\s+public class UserService/s);
});
