import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { analyzeDebugLog, parseJavaStack, parseNodeStack, parsePythonTraceback } from "../src/agents/debug.js";

function tempRepo() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "vibeguard-debug-"));
}

test("parsePythonTraceback extracts in-repository frames", () => {
  const root = tempRepo();
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "src", "app.py"), "def run():\n    missing\n", "utf8");
  const log = `Traceback (most recent call last):
  File "${path.join(root, "src", "app.py")}", line 2, in run
    missing
NameError: name 'missing' is not defined`;

  const frames = parsePythonTraceback(log, root);
  assert.equal(frames.length, 1);
  assert.equal(frames[0].file, "src/app.py");
  assert.equal(frames[0].line, 2);
});

test("parseNodeStack extracts in-repository frames", () => {
  const root = tempRepo();
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "src", "app.js"), "throw new Error('x')\n", "utf8");
  const log = `TypeError: Cannot read properties of undefined
    at run (${path.join(root, "src", "app.js")}:10:5)`;

  const frames = parseNodeStack(log, root);
  assert.equal(frames.length, 1);
  assert.equal(frames[0].file, "src/app.js");
  assert.equal(frames[0].line, 10);
});

test("analyzeDebugLog returns summary, files, snippets, and hints", () => {
  const root = tempRepo();
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "src", "app.py"), "def run():\n    missing\n", "utf8");
  const log = `Traceback (most recent call last):
  File "${path.join(root, "src", "app.py")}", line 2, in run
    missing
NameError: name 'missing' is not defined`;

  const result = analyzeDebugLog(log, { root });
  assert.equal(result.summary.type, "NameError");
  assert.match(result.explanation.message, /references a name/);
  assert.ok(result.explanation.evidence.some((item) => item.includes("src/app.py:2")));
  assert.deepEqual(result.likelyFiles, ["src/app.py"]);
  assert.equal(result.snippets.length, 1);
  assert.ok(result.hints.some((hint) => hint.includes("missing import") || hint.includes("scope")));
});

test("parseJavaStack maps Java stack frames to repository files", () => {
  const root = tempRepo();
  fs.mkdirSync(path.join(root, "src", "main", "java", "com", "example"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "main", "java", "com", "example", "App.java"), "class App {}\n", "utf8");
  const log = `Exception in thread "main" java.lang.NullPointerException: boom
    at com.example.App.run(App.java:12)`;

  const frames = parseJavaStack(log, root, ["src/main/java/com/example/App.java"]);
  assert.equal(frames.length, 1);
  assert.equal(frames[0].file, "src/main/java/com/example/App.java");
  assert.equal(frames[0].line, 12);

  const result = analyzeDebugLog(log, { root });
  assert.equal(result.summary.type, "java.lang.NullPointerException");
  assert.deepEqual(result.likelyFiles, ["src/main/java/com/example/App.java"]);
});

test("analyzeDebugLog adds Django context for template errors", () => {
  const root = tempRepo();
  fs.writeFileSync(path.join(root, "manage.py"), "from django.core.management import execute_from_command_line\n", "utf8");
  fs.mkdirSync(path.join(root, "project"), { recursive: true });
  fs.mkdirSync(path.join(root, "blog"), { recursive: true });
  fs.writeFileSync(path.join(root, "project", "settings.py"), "INSTALLED_APPS = ['blog']\n", "utf8");
  fs.writeFileSync(path.join(root, "project", "urls.py"), "urlpatterns = []\n", "utf8");
  fs.writeFileSync(path.join(root, "blog", "views.py"), "def home(request):\n    return render(request, 'home.html')\n", "utf8");
  const log = `Traceback (most recent call last):
  File "${path.join(root, "blog", "views.py")}", line 2, in home
    return render(request, 'home.html')
django.template.exceptions.TemplateDoesNotExist: home.html`;

  const result = analyzeDebugLog(log, { root });
  assert.equal(result.summary.type, "django.template.exceptions.TemplateDoesNotExist");
  assert.match(result.explanation.message, /Django could not find/);
  assert.ok(result.explanation.evidence.includes("framework=Django"));
  assert.equal(result.frameworkContext.framework, "Django");
  assert.ok(result.likelyFiles.includes("blog/views.py"));
  assert.ok(result.likelyFiles.includes("project/settings.py"));
  assert.ok(result.suggestedTestCommands.includes("python manage.py check"));
  assert.ok(result.hints.some((hint) => hint.includes("TemplateDoesNotExist")));
  assert.ok(!result.frameworkContext.hints.some((hint) => hint.includes("model/query")));
});

test("analyzeDebugLog adds Spring Boot context for dependency injection errors", () => {
  const root = tempRepo();
  fs.mkdirSync(path.join(root, "src", "main", "java", "com", "example"), { recursive: true });
  fs.mkdirSync(path.join(root, "src", "main", "resources"), { recursive: true });
  fs.writeFileSync(path.join(root, "pom.xml"), "<dependency><artifactId>spring-boot-starter</artifactId></dependency>\n", "utf8");
  fs.writeFileSync(path.join(root, "src", "main", "resources", "application.properties"), "spring.profiles.active=test\n", "utf8");
  fs.writeFileSync(path.join(root, "src", "main", "java", "com", "example", "DemoApplication.java"), `package com.example;

import org.springframework.boot.autoconfigure.SpringBootApplication;

@SpringBootApplication
public class DemoApplication {}
`, "utf8");
  fs.writeFileSync(path.join(root, "src", "main", "java", "com", "example", "UserService.java"), "class UserService {}\n", "utf8");
  fs.writeFileSync(path.join(root, "src", "main", "java", "com", "example", "UserRepository.java"), "interface UserRepository {}\n", "utf8");
  const log = `org.springframework.beans.factory.UnsatisfiedDependencyException: Error creating bean with name 'userService'
    at com.example.UserService.<init>(UserService.java:12)
Caused by: org.springframework.beans.factory.NoSuchBeanDefinitionException: No qualifying bean of type 'com.example.UserRepository' available`;

  const result = analyzeDebugLog(log, { root });
  assert.equal(result.summary.type, "org.springframework.beans.factory.NoSuchBeanDefinitionException");
  assert.match(result.explanation.message, /Spring could not construct/);
  assert.ok(result.explanation.evidence.includes("framework=Spring Boot"));
  assert.equal(result.frames[0].file, "src/main/java/com/example/UserService.java");
  assert.equal(result.frameworkContext.framework, "Spring Boot");
  assert.ok(result.likelyFiles.includes("src/main/java/com/example/UserService.java"));
  assert.ok(result.likelyFiles.includes("src/main/java/com/example/UserRepository.java"));
  assert.ok(result.likelyFiles.includes("src/main/resources/application.properties"));
  assert.ok(result.snippets.some((snippet) => snippet.file.endsWith("UserService.java")));
  assert.ok(result.suggestedTestCommands.includes("mvn test"));
  assert.ok(result.hints.some((hint) => hint.includes("dependency injection")));
});
