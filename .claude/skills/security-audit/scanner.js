#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

// Load detection patterns
const criticalPatterns = require('./patterns/critical.json').patterns;
const highPatterns = require('./patterns/high.json').patterns;
const mediumPatterns = require('./patterns/medium.json').patterns;
const lowPatterns = require('./patterns/low.json').patterns;

const allPatterns = [
  ...criticalPatterns,
  ...highPatterns,
  ...mediumPatterns,
  ...lowPatterns
];

/**
 * Audit a skill directory for security issues
 * @param {string} skillPath - Path to skill directory
 * @param {object} options - Audit options
 * @returns {Promise<AuditResult>}
 */
async function auditSkill(skillPath, options = {}) {
  const {
    strictMode = false,
    reportFormat = 'markdown',
    verbose = true
  } = options;

  const findings = [];
  const startTime = Date.now();

  // Validate skill path exists
  if (!fs.existsSync(skillPath)) {
    throw new Error(`Skill path does not exist: ${skillPath}`);
  }

  const stats = fs.statSync(skillPath);
  const isDirectory = stats.isDirectory();

  // Get skill name from path
  const skillName = path.basename(skillPath, '.md');

  // Load SKILL.md if it exists
  let skillMd = null;
  let skillMdPath = null;

  if (isDirectory) {
    skillMdPath = path.join(skillPath, 'SKILL.md');
    if (fs.existsSync(skillMdPath)) {
      skillMd = fs.readFileSync(skillMdPath, 'utf-8');
    }
  } else if (skillPath.endsWith('.md')) {
    skillMdPath = skillPath;
    skillMd = fs.readFileSync(skillPath, 'utf-8');
  }

  // Get all code files to scan
  const filesToScan = isDirectory
    ? getCodeFiles(skillPath)
    : (skillPath.endsWith('.md') ? [] : [skillPath]);

  // Scan each file
  for (const filePath of filesToScan) {
    const relPath = path.relative(skillPath, filePath);

    // Skip empty or very large files
    const fileStats = fs.statSync(filePath);
    if (fileStats.size === 0) continue;
    if (fileStats.size > 10 * 1024 * 1024) {
      // Skip files > 10MB (likely binary or generated)
      findings.push({
        id: 'file-too-large',
        severity: 'LOW',
        category: 'resource-usage',
        message: `File exceeds 10MB limit: ${relPath}`,
        location: { file: relPath, line: 0, snippet: '' },
        remediation: 'Review why this skill includes very large files. Consider excluding from audit.'
      });
      continue;
    }

    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n');

    // Run pattern matching
    for (const pattern of allPatterns) {
      const regex = new RegExp(pattern.regex, 'gm');
      let match;

      while ((match = regex.exec(content)) !== null) {
        const lineNum = content.substring(0, match.index).split('\n').length;
        const snippet = lineNum > 0 && lineNum <= lines.length
          ? lines[lineNum - 1].trim()
          : '';

        // Context check for patterns that require it
        if (pattern.requiresContext && pattern.contextCheck === 'skillMdMentionsDomain') {
          const urlMatch = match[0].match(/https?:\/\/([^/'")\s]+)/);
          if (urlMatch && skillMd) {
            const domain = urlMatch[1];
            // Case-insensitive domain check
            if (skillMd.toLowerCase().includes(domain.toLowerCase())) {
              // Domain is documented, downgrade severity or skip
              continue;
            }
          }
        }

        findings.push({
          id: pattern.id,
          severity: pattern.severity,
          category: pattern.category,
          message: pattern.message,
          location: {
            file: isDirectory ? relPath : path.basename(filePath),
            line: lineNum,
            snippet: snippet.length > 100 ? snippet.substring(0, 100) + '...' : snippet
          },
          remediation: pattern.remediation
        });
      }
    }
  }

  // Check for missing SKILL.md
  if (isDirectory && !skillMd) {
    findings.push({
      id: 'missing-skill-md',
      severity: 'LOW',
      category: 'documentation',
      message: 'Missing SKILL.md file',
      location: { file: 'N/A', line: 0, snippet: '' },
      remediation: 'Create a SKILL.md file with skill description and metadata.'
    });
  }

  // Calculate risk score
  const riskScore = calculateRiskScore(findings);
  const hasCritical = findings.some(f => f.severity === 'CRITICAL');
  const status = getVerdict(riskScore, hasCritical, strictMode);

  const result = {
    skillName,
    skillPath,
    status,
    riskScore,
    findings,
    summary: {
      critical: findings.filter(f => f.severity === 'CRITICAL').length,
      high: findings.filter(f => f.severity === 'HIGH').length,
      medium: findings.filter(f => f.severity === 'MEDIUM').length,
      low: findings.filter(f => f.severity === 'LOW').length,
      info: findings.filter(f => f.severity === 'INFO').length
    },
    auditedAt: new Date().toISOString(),
    duration: Date.now() - startTime
  };

  // Generate report
  if (reportFormat === 'markdown') {
    result.report = generateMarkdownReport(result, verbose);
  } else if (reportFormat === 'json') {
    result.report = JSON.stringify(result, null, 2);
  }

  return result;
}

/**
 * Get all code files in a directory (recursively)
 */
function getCodeFiles(dir) {
  const files = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      // Skip node_modules, .git, etc.
      if (['node_modules', '.git', 'dist', 'build'].includes(entry.name)) {
        continue;
      }
      files.push(...getCodeFiles(fullPath));
    } else if (entry.isFile()) {
      // Only scan code files
      const ext = path.extname(entry.name);
      if (['.js', '.ts', '.mjs', '.cjs', '.jsx', '.tsx', '.sh', '.bash'].includes(ext)) {
        files.push(fullPath);
      }
    }
  }

  return files;
}

/**
 * Calculate overall risk score from findings
 */
function calculateRiskScore(findings) {
  const weights = {
    CRITICAL: 100,
    HIGH: 30,
    MEDIUM: 10,
    LOW: 3,
    INFO: 0
  };

  let score = 0;
  for (const finding of findings) {
    score += weights[finding.severity];
    if (score >= 100) return 100;
  }

  return Math.min(score, 100);
}

/**
 * Get verdict based on risk score and findings
 */
function getVerdict(riskScore, hasCritical, strictMode) {
  if (hasCritical) return 'FAIL';
  if (strictMode && riskScore > 0) return 'FAIL';
  if (riskScore >= 50) return 'REVIEW_NEEDED';
  return 'PASS';
}

/**
 * Generate markdown audit report
 */
function generateMarkdownReport(result, verbose) {
  const lines = [];

  // Header
  lines.push(`# Security Audit Report: ${result.skillName}`);
  lines.push('');
  lines.push(`**Skill**: ${result.skillName}`);
  lines.push(`**Path**: ${result.skillPath}`);
  lines.push(`**Audited**: ${result.auditedAt}`);
  lines.push(`**Duration**: ${result.duration}ms`);
  lines.push(`**Risk Score**: ${result.riskScore}/100`);

  const statusIcon = result.status === 'PASS' ? '✅' : result.status === 'FAIL' ? '❌' : '⚠️';
  lines.push(`**Verdict**: ${statusIcon} ${result.status}`);
  lines.push('');

  // Summary
  lines.push('## Summary');
  if (result.findings.length === 0) {
    lines.push('No security issues detected. This skill appears safe to install.');
  } else {
    const parts = [];
    if (result.summary.critical > 0) parts.push(`**${result.summary.critical} critical**`);
    if (result.summary.high > 0) parts.push(`**${result.summary.high} high**`);
    if (result.summary.medium > 0) parts.push(`${result.summary.medium} medium`);
    if (result.summary.low > 0) parts.push(`${result.summary.low} low`);

    lines.push(`This skill contains ${parts.join(', ')} security issue${result.findings.length > 1 ? 's' : ''}.`);
  }
  lines.push('');

  // Critical findings
  const critical = result.findings.filter(f => f.severity === 'CRITICAL');
  if (critical.length > 0) {
    lines.push('## Critical Findings');
    lines.push('');
    critical.forEach((finding, i) => {
      lines.push(`### ${i + 1}. ${finding.message}`);
      lines.push(`**File**: \`${finding.location.file}:${finding.location.line}\``);
      lines.push(`**Severity**: 🔴 CRITICAL`);
      lines.push(`**Category**: ${finding.category}`);
      lines.push('');
      lines.push('```javascript');
      lines.push(finding.location.snippet);
      lines.push('```');
      lines.push('');
      lines.push(`**Issue**: ${finding.message}`);
      lines.push('');
      lines.push(`**Remediation**: ${finding.remediation}`);
      lines.push('');
      lines.push('---');
      lines.push('');
    });
  }

  // High findings (if verbose)
  const high = result.findings.filter(f => f.severity === 'HIGH');
  if (verbose && high.length > 0) {
    lines.push('## High-Severity Warnings');
    lines.push('');
    high.forEach((finding, i) => {
      lines.push(`### ${i + 1}. ${finding.message}`);
      lines.push(`**File**: \`${finding.location.file}:${finding.location.line}\``);
      lines.push(`**Category**: ${finding.category}`);
      lines.push('');
      lines.push('```javascript');
      lines.push(finding.location.snippet);
      lines.push('```');
      lines.push('');
      lines.push(`**Remediation**: ${finding.remediation}`);
      lines.push('');
    });
    lines.push('---');
    lines.push('');
  }

  // Medium findings (if verbose)
  const medium = result.findings.filter(f => f.severity === 'MEDIUM');
  if (verbose && medium.length > 0) {
    lines.push('## Medium-Severity Issues');
    lines.push('');
    medium.forEach((finding) => {
      lines.push(`- **${finding.message}** (\`${finding.location.file}:${finding.location.line}\`)`);
    });
    lines.push('');
  }

  // Low findings (summary only unless verbose)
  const low = result.findings.filter(f => f.severity === 'LOW');
  if (low.length > 0) {
    lines.push('## Informational');
    lines.push('');
    if (verbose) {
      low.forEach((finding) => {
        lines.push(`- ${finding.message} (\`${finding.location.file}:${finding.location.line}\`)`);
      });
    } else {
      lines.push(`${low.length} informational finding${low.length > 1 ? 's' : ''} (use verbose mode for details)`);
    }
    lines.push('');
  }

  // Recommendation
  lines.push('## Recommendation');
  if (result.status === 'FAIL') {
    lines.push('**DO NOT INSTALL** this skill until critical issues are resolved.');
  } else if (result.status === 'REVIEW_NEEDED') {
    lines.push('**Manual review recommended** before installation. Some patterns require human judgment.');
  } else {
    lines.push('This skill appears safe to install based on automated scanning.');
  }
  lines.push('');

  // Footer
  lines.push('---');
  lines.push('*security-audit v2.0.0*');

  return lines.join('\n');
}

// CLI usage
if (require.main === module) {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.error('Usage: node scanner.js <skill-path> [--strict] [--json] [--quiet]');
    process.exit(1);
  }

  const skillPath = args[0];
  const options = {
    strictMode: args.includes('--strict'),
    reportFormat: args.includes('--json') ? 'json' : 'markdown',
    verbose: !args.includes('--quiet')
  };

  auditSkill(skillPath, options)
    .then(result => {
      console.log(result.report);

      // Exit code based on verdict
      if (result.status === 'FAIL') {
        process.exit(1);
      } else if (result.status === 'REVIEW_NEEDED') {
        process.exit(2);
      } else {
        process.exit(0);
      }
    })
    .catch(error => {
      console.error('Audit failed:', error.message);
      process.exit(3);
    });
}

module.exports = { auditSkill };
