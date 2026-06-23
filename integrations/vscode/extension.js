const vscode = require("vscode");
const childProcess = require("child_process");

function workspaceRoot() {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

function runVibeGuard(args) {
  const root = workspaceRoot();
  if (!root) {
    vscode.window.showErrorMessage("Open a workspace before running VibeGuard.");
    return;
  }

  const output = vscode.window.createOutputChannel("VibeGuard");
  output.show(true);
  const command = `node ./bin/vibeguard.js ${args.join(" ")}`;
  output.appendLine(`$ ${command}`);
  childProcess.exec(command, { cwd: root }, (error, stdout, stderr) => {
    if (stdout) output.appendLine(stdout);
    if (stderr) output.appendLine(stderr);
    if (error) vscode.window.showErrorMessage(`VibeGuard failed: ${error.message}`);
  });
}

function activate(context) {
  context.subscriptions.push(
    vscode.commands.registerCommand("vibeguard.debug", async () => {
      const file = await vscode.window.showInputBox({ prompt: "Path to error log file" });
      if (file) runVibeGuard(["debug", "--log", JSON.stringify(file), "--json"]);
    }),
    vscode.commands.registerCommand("vibeguard.review", () => runVibeGuard(["review", "--json"])),
    vscode.commands.registerCommand("vibeguard.onboard", () => runVibeGuard(["onboard", "--write", "--json"])),
    vscode.commands.registerCommand("vibeguard.policyCheck", async () => {
      const file = await vscode.window.showInputBox({ prompt: "Path to check" });
      if (file) runVibeGuard(["policy", "check", "--path", JSON.stringify(file), "--json"]);
    })
  );
}

function deactivate() {}

module.exports = { activate, deactivate };
