# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in Agav, please report it responsibly.

**Do not open a public issue.** Instead, email **security@agav.dev** with:

- A description of the vulnerability
- Steps to reproduce it
- The potential impact
- Any suggested fix (optional)

We will acknowledge your report within **48 hours** and aim to provide a fix or mitigation within **7 days** for critical issues.

## Scope

The following are in scope:

- Command injection via user input or tool arguments
- Credential leakage (API keys, tokens) through logs, shell history, or child processes
- Sandbox escapes in the shell execution layer
- Path traversal in file read/write operations
- Prompt injection that causes the agent to exfiltrate data

## Out of Scope

- Vulnerabilities in upstream LLM providers (OpenAI, Anthropic, Google, Ollama)
- Issues requiring physical access to the machine
- Social engineering attacks

## Disclosure Policy

We follow coordinated disclosure. Once a fix is released, we will:

1. Credit the reporter (unless they prefer anonymity)
2. Publish a security advisory on GitHub
3. Include the fix in the next release with a changelog entry

Thank you for helping keep Agav secure.
