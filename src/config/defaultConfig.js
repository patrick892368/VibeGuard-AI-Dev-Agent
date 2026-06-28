export const defaultConfig = {
  version: 1,
  paths: {
    allow: ["src/**", "bin/**", "test/**", "tests/**", "docs/**", "reports/**", "logs/**", "*.log", "README.md", "package.json", ".vibeguard.yaml", ".gitignore"],
    deny: [".env", ".env.*", ".git/**", "node_modules/**", "dist/**", "build/**", "coverage/**", "vendor/**"],
    require_confirmation: [
      ".github/workflows/**",
      "Dockerfile",
      "docker-compose*.yml",
      "package-lock.json",
      "pnpm-lock.yaml",
      "yarn.lock",
      "poetry.lock",
      "requirements*.txt",
      "migrations/**",
      "db/migrate/**",
      "terraform/**",
      "k8s/**"
    ]
  },
  commands: {
    deny: ["rm -rf", "sudo", "chmod 777", "curl * | sh", "wget * | sh", "git reset --hard", "git push --force"],
    require_confirmation: [
      "npm install",
      "pip install",
      "poetry add",
      "pnpm add",
      "docker compose up",
      "alembic upgrade",
      "python manage.py migrate",
      "git switch -c",
      "git commit",
      "git push",
      "gh pr create",
      "gh pr comment",
      "gh api"
    ]
  },
  agents: {
    debug: { enabled: true, auto_patch: false, auto_run_tests: false },
    onboarding: { enabled: true },
    test_writer: { enabled: true, min_coverage_target: 80 },
    review: { enabled: true }
  }
};
