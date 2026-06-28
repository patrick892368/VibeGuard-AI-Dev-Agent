import { parsePatchFiles } from "../patch/parsePatch.js";
import { writeFileWithPolicy } from "../policy/safeWrite.js";
import { GITHUB_DETECT_COMMAND, checkGitHubCommandsPolicy, commentPullRequestWithGh } from "../integrations/github.js";

function changedEntries(diffText) {
  const entries = [];
  let currentFile = "diff";
  let newLine = null;
  for (const line of diffText.replace(/\r\n/g, "\n").split("\n")) {
    if (line.startsWith("diff --git ")) {
      const parts = line.split(/\s+/);
      currentFile = (parts[3] || parts[2] || "diff").replace(/^b\//, "").replace(/^a\//, "");
      newLine = null;
      continue;
    }
    if (line.startsWith("+++ ")) {
      const value = line.slice(4).trim().split(/\s+/)[0];
      if (value !== "/dev/null") currentFile = value.replace(/^b\//, "").replace(/^a\//, "");
      continue;
    }
    if (line.startsWith("@@")) {
      const match = line.match(/\+(\d+)(?:,\d+)?/);
      newLine = match ? Number(match[1]) : null;
      continue;
    }
    if (line.startsWith("+") && !line.startsWith("+++")) {
      entries.push({ file: currentFile, line: newLine, value: line.slice(1) });
      if (newLine !== null) newLine += 1;
      continue;
    }
    if (line.startsWith("-") && !line.startsWith("---")) {
      continue;
    }
    if (newLine !== null && line.startsWith(" ")) {
      newLine += 1;
    }
  }
  return entries;
}

function recommendationFor(category, message) {
  if (message.includes("Secret-looking")) return "Remove the literal and load it from a secret manager or environment variable.";
  if (message.includes("Dynamic code execution")) return "Replace dynamic execution with explicit dispatch or a sandboxed interpreter with strict input validation.";
  if (message.includes("Shell injection risk")) return "Avoid shell execution for dynamic input; pass argv arrays through a policy-gated runner and validate each argument.";
  if (message.includes("Shell/process execution")) return "Route commands through a policy-gated runner and validate every user-controlled argument.";
  if (message.includes("Potential SSRF")) return "Validate destination URLs against an allowlist, block private/internal networks, and avoid server-side fetches to arbitrary user input.";
  if (message.includes("TLS certificate verification")) return "Keep certificate verification enabled and configure trusted CAs or certificate pinning instead of disabling TLS checks.";
  if (message.includes("Weak hash algorithm")) return "Use SHA-256 for non-password integrity checks, or a password hashing/KDF such as argon2, bcrypt, scrypt, or PBKDF2 for credentials.";
  if (message.includes("Insecure randomness")) return "Use a cryptographically secure random generator such as crypto.randomBytes, crypto.getRandomValues, Python secrets, or Java SecureRandom.";
  if (message.includes("SQL string concatenation")) return "Use parameterized queries or the framework query builder for every dynamic value.";
  if (message.includes("HTML injection")) return "Render text safely or sanitize trusted markup before assigning it to an HTML sink.";
  if (message.includes("Unsafe deserialization")) return "Use safe loaders and reject untrusted serialized input.";
  if (message.includes("Synchronous filesystem")) return "Move blocking I/O out of request or hot paths, or use async APIs.";
  if (category === "testing") return "Add or update a focused test that covers the changed source behavior.";
  if (category === "database") return "Document rollback, migration order, and deployment coordination before merge.";
  if (category === "deployment") return "Confirm CI/deploy blast radius and require an explicit reviewer for infrastructure changes.";
  if (message.includes("Mutable default argument")) return "Use a sentinel default such as None and create a new collection inside the function.";
  if (message.includes("Assignment inside conditional")) return "Move the assignment before the condition, or use an explicit comparison.";
  if (message.includes("Swallowed exception")) return "Handle the exception, log enough context, or rethrow it instead of silently ignoring it.";
  if (category === "security") return "Review the changed file for secret exposure and remove sensitive data from the diff.";
  if (category === "maintainability") return "Link the TODO/FIXME to a tracked issue or complete it before merge.";
  return "Inspect this finding and add a concrete fix or justification before merge.";
}

function finding(severity, file, category, message, addition = null) {
  return {
    severity,
    file,
    line: addition?.line ?? null,
    category,
    message,
    recommendation: recommendationFor(category, message)
  };
}

function summarizeBySeverity(findings) {
  return findings.reduce((summary, item) => {
    summary[item.severity] = (summary[item.severity] || 0) + 1;
    return summary;
  }, { high: 0, medium: 0, low: 0 });
}

function actionItems(findings) {
  return findings.map((item) => ({
    severity: item.severity,
    file: item.file,
    line: item.line,
    category: item.category,
    action: item.recommendation
  }));
}

function reviewComments(findings) {
  return findings
    .filter((item) => item.file && item.line)
    .map((item) => ({
      path: item.file,
      line: item.line,
      side: "RIGHT",
      severity: item.severity,
      category: item.category,
      body: `**VibeGuard ${item.severity.toUpperCase()} ${item.category}**\n\n${item.message}\n\nRecommendation: ${item.recommendation}`
    }));
}

function findingLocation(item) {
  return item.line ? `${item.file}:${item.line}` : item.file;
}

function buildReviewMarkdown(files, findings, summaryBySeverity) {
  const changedFiles = files.map((file) => `- \`${file}\``).join("\n") || "- No files detected";
  const findingLines = findings.map((item) =>
    `- **${item.severity.toUpperCase()} ${item.category}** at \`${findingLocation(item)}\`: ${item.message}\n  Recommendation: ${item.recommendation}`
  ).join("\n") || "- No findings.";

  return `## VibeGuard Review

Changed files: ${files.length}
Findings: ${findings.length} (high: ${summaryBySeverity.high}, medium: ${summaryBySeverity.medium}, low: ${summaryBySeverity.low})

### Changed Files

${changedFiles}

### Findings

${findingLines}
`;
}

export function analyzeReviewDiff(diffText, options = {}) {
  const files = parsePatchFiles(diffText);
  const additions = changedEntries(diffText);
  const findings = [];

  for (const file of files) {
    if (/\.env|secret|credential/i.test(file)) {
      findings.push(finding("high", file, "security", "Sensitive-looking file changed. Verify this does not expose secrets."));
    }
    if (/migrations?|db\/migrate/i.test(file)) {
      findings.push(finding("medium", file, "database", "Database migration changed. Confirm rollback and deployment order."));
    }
    if (/\.github\/workflows|Dockerfile|k8s|terraform/i.test(file)) {
      findings.push(finding("medium", file, "deployment", "Deployment or CI configuration changed. Confirm blast radius before merging."));
    }
  }

  for (const addition of additions) {
    const value = addition.value;
    if (/(api[_-]?key|secret|token|password)\s*[:=]\s*["'][^"']{8,}/i.test(value)) {
      findings.push(finding("high", addition.file, "security", "Secret-looking literal introduced. Move credentials to a secret manager or environment variable.", addition));
    }
    if (/\beval\s*\(|new Function\s*\(/.test(value)) {
      findings.push(finding("high", addition.file, "security", "Dynamic code execution introduced. Avoid eval/new Function unless strictly sandboxed.", addition));
    }
    const ssrfRisk =
      /\bfetch\s*\([^)]*(?:req\.|request\.|ctx\.|params|query|body|args|callbackUrl|targetUrl|redirectUrl)/i.test(value) ||
      /\baxios\.(?:get|post|put|delete|request)\s*\([^)]*(?:req\.|request\.|ctx\.|params|query|body|args|callbackUrl|targetUrl|redirectUrl)/i.test(value) ||
      /\b(?:got|request)\s*\([^)]*(?:req\.|request\.|ctx\.|params|query|body|args|callbackUrl|targetUrl|redirectUrl)/i.test(value) ||
      /\brequests\.(?:get|post|put|delete|request)\s*\([^)]*(?:req\.|request\.|params|query|body|args|callbackUrl|targetUrl|redirectUrl)/i.test(value) ||
      /\burllib\.request\.urlopen\s*\([^)]*(?:req\.|request\.|params|query|body|args|callbackUrl|targetUrl|redirectUrl)/i.test(value) ||
      /\b(?:new\s+URL|URI\.create|HttpRequest\.newBuilder|RestTemplate\.\w+|restTemplate\.\w+|WebClient\.create)\s*\([^)]*(?:req\.|request\.|params|query|body|args|callbackUrl|targetUrl|redirectUrl|targetUri|targetUrl)/i.test(value);
    if (ssrfRisk) {
      findings.push(finding("high", addition.file, "security", "Potential SSRF sink introduced. Server-side requests should not fetch arbitrary user-controlled URLs.", addition));
    }
    if (/rejectUnauthorized\s*:\s*false|verify\s*=\s*False|NODE_TLS_REJECT_UNAUTHORIZED\s*=\s*["']?0/i.test(value)) {
      findings.push(finding("high", addition.file, "security", "TLS certificate verification disabled. This can allow man-in-the-middle attacks.", addition));
    }
    if (/\bcreateHash\s*\(\s*["'](?:md5|sha1)["']|hashlib\.(?:md5|sha1)\s*\(|MessageDigest\.getInstance\s*\(\s*["'](?:MD5|SHA-?1)["']/i.test(value)) {
      findings.push(finding("medium", addition.file, "security", "Weak hash algorithm introduced. MD5 and SHA-1 are not appropriate for security-sensitive hashing.", addition));
    }
    if (/(?:token|secret|password|session|csrf|nonce)\w*\s*[:=].*\bMath\.random\s*\(|(?:token|secret|password|session|csrf|nonce)\w*\s*[:=].*\brandom\.(?:random|randint|choice|choices)\s*\(|(?:token|secret|password|session|csrf|nonce)\w*\s*=\s*new\s+Random\s*\(/i.test(value)) {
      findings.push(finding("medium", addition.file, "security", "Insecure randomness used for a security-sensitive value.", addition));
    }
    const shellInjectionRisk =
      /\b(exec|execSync)\s*\([^)]*(?:`|\+|\$\{)/.test(value) ||
      /\bspawn\s*\([^)]*\{[^}]*shell\s*:\s*true/.test(value) ||
      /\bsubprocess\.(?:run|Popen|call|check_call|check_output)\s*\([^)]*shell\s*=\s*True/.test(value) ||
      /\bos\.system\s*\(/.test(value) ||
      /\bRuntime\.getRuntime\(\)\.exec\s*\([^)]*(?:\+|req\.|request\.|params|query|body|args|command|cmd)/i.test(value) ||
      /\bnew\s+ProcessBuilder\s*\([^)]*(?:"sh"|"bash"|"-c"|req\.|request\.|params|query|body|args|command|cmd)/i.test(value);
    if (shellInjectionRisk) {
      findings.push(finding("high", addition.file, "security", "Shell injection risk introduced. Avoid shell=True, os.system, or shell exec with dynamic strings.", addition));
    } else if (/\bexec(?:Sync|File|FileSync)?\s*\(|child_process|subprocess\.|Runtime\.getRuntime\(\)\.exec\s*\(|new\s+ProcessBuilder\s*\(/.test(value)) {
      findings.push(finding("medium", addition.file, "security", "Shell/process execution introduced. Validate inputs and enforce command policy.", addition));
    }
    if (/TODO|FIXME/.test(value)) {
      findings.push(finding("low", addition.file, "maintainability", "TODO/FIXME added. Confirm it is intentional and tracked.", addition));
    }
    if (/SELECT .* \+|WHERE .* \+|query\s*\(.*\+/.test(value)) {
      findings.push(finding("high", addition.file, "security", "Possible SQL string concatenation introduced. Prefer parameterized queries.", addition));
    }
    if (/innerHTML\s*=|dangerouslySetInnerHTML/.test(value)) {
      findings.push(finding("high", addition.file, "security", "HTML injection sink introduced. Sanitize trusted markup or use safe text rendering.", addition));
    }
    if (/pickle\.loads?\(|yaml\.load\s*\(/.test(value)) {
      findings.push(finding("high", addition.file, "security", "Unsafe deserialization introduced. Use safe loaders or validate trusted input only.", addition));
    }
    if (/fs\.(readFileSync|writeFileSync)|readFileSync\(|writeFileSync\(/.test(value) && /\.(js|ts)$/.test(addition.file)) {
      findings.push(finding("medium", addition.file, "performance", "Synchronous filesystem I/O introduced. Confirm this is not on a request or hot path.", addition));
    }
    if (/^\s*def\s+\w+\([^)]*=\s*(\[\]|\{\}|set\(\))/.test(value) && /\.py$/.test(addition.file)) {
      findings.push(finding("medium", addition.file, "bug", "Mutable default argument introduced. This can leak state across calls.", addition));
    }
    if (/\b(if|while)\s*\([^)]*(?<![=!<>])=(?![=>])[^)]*\)/.test(value) && /\.(js|ts|jsx|tsx)$/.test(addition.file)) {
      findings.push(finding("medium", addition.file, "bug", "Assignment inside conditional introduced. Confirm this is not a mistaken comparison.", addition));
    }
    if (/\bcatch\s*(?:\([^)]*\))?\s*\{\s*\}/.test(value) && /\.(js|ts|jsx|tsx)$/.test(addition.file)) {
      findings.push(finding("medium", addition.file, "bug", "Swallowed exception introduced. Empty catch blocks can hide failed operations.", addition));
    }
    if (/^\s*except(?:\s+[\w.]+)?\s*:\s*pass\s*(?:#.*)?$/.test(value) && /\.py$/.test(addition.file)) {
      findings.push(finding("medium", addition.file, "bug", "Swallowed exception introduced. Bare pass handlers can hide failed operations.", addition));
    }
  }

  const changedHasSource = files.some((file) => /\.(js|ts|py|java)$/.test(file) && !/(test|spec)/.test(file));
  const changedHasTest = files.some((file) => /(test|spec|tests\/|__tests__)/.test(file));
  if (changedHasSource && !changedHasTest) {
    findings.push(finding("medium", "tests", "testing", "Source files changed without matching test changes."));
  }

  const severityOrder = { high: 0, medium: 1, low: 2 };
  findings.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity] || a.file.localeCompare(b.file));

  const summaryBySeverity = summarizeBySeverity(findings);
  return {
    files,
    summary: `${files.length} changed file(s), ${findings.length} finding(s).`,
    summaryBySeverity,
    actionItems: actionItems(findings),
    reviewComments: reviewComments(findings),
    markdown: buildReviewMarkdown(files, findings, summaryBySeverity),
    findings
  };
}

export function writeReviewComment(root, diffText, outputPath, engine, options = {}) {
  const review = analyzeReviewDiff(diffText, options);
  return {
    ...review,
    writtenComment: writeFileWithPolicy(root, outputPath, review.markdown, engine, options)
  };
}

export async function publishReviewComment(root, diffText, engine, options = {}) {
  if (!options.pr) throw new Error("GitHub PR number is required for review comment publishing");
  const review = options.review || analyzeReviewDiff(diffText, options);
  const writtenComment = options.writeComment
    ? writeFileWithPolicy(root, options.writeComment, review.markdown, engine, options)
    : undefined;
  const commentOptions = {
    pr: options.pr,
    body: review.markdown,
    useApi: Boolean(options.useApi),
    env: options.env
  };
  const dryRun = await commentPullRequestWithGh(root, {
    ...commentOptions,
    dryRun: true
  });
  const commandPolicy = checkGitHubCommandsPolicy([{ index: 1, command: dryRun.command }], engine, {
    confirmed: Boolean(options.confirmed),
    stage: options.stage || "review_comment_policy"
  });

  if (options.execute === true && commandPolicy.status !== "allow") {
    return {
      status: commandPolicy.status,
      stage: commandPolicy.stage,
      review,
      writtenComment,
      commandPolicy,
      publish: dryRun
    };
  }

  if (options.execute === true) {
    const prerequisitePolicy = checkGitHubCommandsPolicy([{ index: 1, command: GITHUB_DETECT_COMMAND }], engine, {
      confirmed: Boolean(options.confirmed),
      stage: options.prerequisiteStage || "review_comment_prerequisite_policy"
    });
    if (prerequisitePolicy.status !== "allow") {
      return {
        ...prerequisitePolicy,
        review,
        writtenComment,
        commandPolicy,
        publish: dryRun
      };
    }
  }

  const publish = options.execute === true
    ? await commentPullRequestWithGh(root, {
      ...commentOptions,
      dryRun: false,
      engine,
      confirmed: Boolean(options.confirmed),
      auditLog: options.auditLog
    })
    : dryRun;

  return {
    status: publish.status,
    review,
    writtenComment,
    commandPolicy,
    publish
  };
}
