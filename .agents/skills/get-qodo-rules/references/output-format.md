# Formatting and Outputting Rules

## Output Structure

Print the following header:

```
# 📋 Qodo Rules Loaded

Scope: `{QUERY_SCOPE}`
Rules loaded: **{TOTAL_RULES}** (universal, org level, repo level, and path level rules)

These rules must be applied during code generation based on severity:
```

## Grouping by Severity

Group rules into three sections and print each non-empty section:

**ERROR** (`severity == "error"`):
```
## ❌ ERROR Rules (Must Comply) - {count}

- **{name}** ({category}): {description}
```

**WARNING** (`severity == "warning"`):
```
## ⚠️  WARNING Rules (Should Comply) - {count}

- **{name}** ({category}): {description}
```

**RECOMMENDATION** (`severity == "recommendation"`):
```
## 💡 RECOMMENDATION Rules (Consider) - {count}

- **{name}** ({category}): {description}
```

End output with `---`.
