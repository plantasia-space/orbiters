#!/usr/bin/env node

import { readdirSync, statSync, readFileSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = resolve(process.cwd());
const TARGET_DIRS = ['src', 'scripts'];
const TARGET_FILES = ['vite.config.js'];
const JS_EXTENSIONS = new Set(['.js', '.mjs', '.cjs']);
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git']);

function hasTargetExtension(filename) {
  const dot = filename.lastIndexOf('.');
  if (dot < 0) return false;
  return JS_EXTENSIONS.has(filename.slice(dot));
}

function collectFiles(startPath, out = []) {
  const entries = readdirSync(startPath, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const fullPath = join(startPath, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      collectFiles(fullPath, out);
      continue;
    }
    if (entry.isFile() && hasTargetExtension(entry.name)) {
      out.push(fullPath);
    }
  }
  return out;
}

function existingPath(path) {
  try {
    return statSync(path);
  } catch (_) {
    return null;
  }
}

const files = [];

for (const dir of TARGET_DIRS) {
  const abs = resolve(ROOT, dir);
  const stats = existingPath(abs);
  if (stats?.isDirectory()) {
    collectFiles(abs, files);
  }
}

for (const file of TARGET_FILES) {
  const abs = resolve(ROOT, file);
  const stats = existingPath(abs);
  if (stats?.isFile()) {
    files.push(abs);
  }
}

files.sort();

if (!files.length) {
  console.log('No JavaScript files found to lint.');
  process.exit(0);
}

let failed = false;
let warningCount = 0;
const WARN_PREVIEW_LIMIT = 80;
let warningPreviewPrinted = 0;

const ISSUE_RULES = [
  {
    id: 'merge-markers',
    severity: 'error',
    test: (line) =>
      line.startsWith('<<<<<<< ') || line.startsWith('=======') || line.startsWith('>>>>>>> '),
    message: 'merge conflict marker found',
  },
  {
    id: 'debugger',
    severity: 'error',
    test: (line) => /^\s*debugger\s*;?\s*$/.test(line),
    message: 'debugger statement found',
  },
  {
    id: 'var',
    severity: 'warn',
    test: (line) => /\bvar\s+[A-Za-z_$]/.test(line),
    message: 'var declaration found (prefer const/let)',
  },
  {
    id: 'trailing-whitespace',
    severity: 'warn',
    test: (line) => /[ \t]+$/.test(line),
    message: 'trailing whitespace',
  },
  {
    id: 'console-log',
    severity: 'warn',
    test: (line) => /\bconsole\.(log|debug|info)\s*\(/.test(line),
    message: 'console log/debug/info found',
  },
];

function scanQualityIssues(file) {
  const text = readFileSync(file, 'utf8');
  const lines = text.split(/\r?\n/);
  const rel = relative(ROOT, file);
  const issues = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    for (const rule of ISSUE_RULES) {
      if (rule.test(line)) {
        issues.push({
          severity: rule.severity,
          rel,
          line: i + 1,
          message: rule.message,
        });
      }
    }
  }

  return issues;
}

for (const file of files) {
  const check = spawnSync(process.execPath, ['--check', file], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  if (check.status !== 0) {
    failed = true;
    const rel = relative(ROOT, file);
    console.error(`\n[lint] Syntax check failed: ${rel}`);
    if (check.stderr) process.stderr.write(check.stderr);
    if (check.stdout) process.stdout.write(check.stdout);
  }

  const issues = scanQualityIssues(file);
  for (const issue of issues) {
    const prefix = issue.severity === 'error' ? 'error' : 'warn';
    if (issue.severity === 'error') {
      failed = true;
    } else {
      warningCount += 1;
      if (warningPreviewPrinted >= WARN_PREVIEW_LIMIT) {
        continue;
      }
      warningPreviewPrinted += 1;
    }
    console[issue.severity === 'error' ? 'error' : 'warn'](
      `[lint:${prefix}] ${issue.rel}:${issue.line} ${issue.message}`,
    );
  }
}

if (failed) {
  console.error('\nLint failed.');
  process.exit(1);
}

if (warningCount > 0) {
  if (warningCount > warningPreviewPrinted) {
    console.warn(
      `[lint:warn] ... ${warningCount - warningPreviewPrinted} additional warning(s) hidden (preview limit ${WARN_PREVIEW_LIMIT}).`,
    );
  }
  console.warn(`\nLint OK with ${warningCount} warning(s) across ${files.length} files.`);
} else {
  console.log(`Lint OK (${files.length} files checked).`);
}
