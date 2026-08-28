---
name: security-scan
description: Check code for security vulnerabilities
version: 1.0.0
invocation: user
allowed-tools: read_file grep_search find_files list_directory run_command
tags:
  - security
  - audit
---

# Security Scan

Scan code for security vulnerabilities and report findings with remediation guidance.

## Instructions

1. Identify the project's language, framework, and dependency manager.
2. Scan for OWASP Top 10 vulnerabilities:
   - **Injection**: SQL injection, command injection, XSS, template injection. Search for string concatenation in queries, unsanitized user input in shell commands or HTML output.
   - **Broken Authentication**: Weak password handling, missing rate limiting, session fixation.
   - **Sensitive Data Exposure**: Hardcoded secrets, API keys, passwords, tokens in source files or config. Grep for patterns like `password=`, `secret`, `api_key`, `token`, base64-encoded credentials.
   - **Insecure Deserialization**: Use of pickle, eval, unserialize, or YAML.load with untrusted data.
   - **Missing Input Validation**: Endpoints or functions accepting user input without type checks, length limits, or sanitization.
   - **Security Misconfiguration**: Debug mode enabled, CORS wildcard, permissive file permissions, missing security headers.
   - **Vulnerable Dependencies**: Run `npm audit`, `pip audit`, or equivalent to check for known CVEs.
3. For each finding, report:
   - **Severity**: Critical, High, Medium, or Low
   - **Location**: File path and line number
   - **Description**: What the vulnerability is and how it could be exploited
   - **Remediation**: Specific steps or code changes to fix it
4. Sort findings by severity (critical first).
5. If no vulnerabilities are found, confirm the scan was clean and note what was checked.
