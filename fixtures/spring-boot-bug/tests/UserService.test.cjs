const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

test("UserService is discoverable as a Spring service", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "main", "java", "com", "example", "UserService.java"), "utf8");
  const pom = fs.readFileSync(path.join(__dirname, "..", "pom.xml"), "utf8");
  const smokeTest = fs.readFileSync(path.join(__dirname, "..", "src", "test", "java", "com", "example", "UserServiceSpringSmokeTest.java"), "utf8");
  assert.match(source, /import\s+org\.springframework\.stereotype\.Service;/);
  assert.match(source, /@Service\s+public class UserService/s);
  assert.match(pom, /spring-boot-starter-test/);
  assert.match(smokeTest, /@SpringBootTest/);
});
