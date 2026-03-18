# Project Architecture

- Service: AI PR Reviewer GitHub Action
- Language: Node.js (TypeScript), runtime node20
- Entry: `dist/index.js` (built from `src/index.ts`)
- Inputs: `project.md`, PR metadata, changed files, scan logs
- Output: PR comment or job summary with AI review

Constraints:
- Keep prompts concise; truncate large diffs/logs.
- Do not exfiltrate secrets; redact sensitive values.
- Prefer actionable, file-referenced feedback with test guidance.
