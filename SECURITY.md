# Security Policy

## Supported versions

Security fixes are applied to the latest `main` branch. Older forks and modified deployments are not maintained by this project.

## Reporting a vulnerability

Please **do not open a public issue** for security problems, leaked credentials, or reports that include API keys, query logs, or other sensitive data.

Use GitHub's **private vulnerability reporting** for this repository if it is enabled. If private reporting is unavailable, contact the maintainer through their GitHub profile and ask for a private channel.

When reporting, include:

- a short description of the issue;
- steps to reproduce, without real API keys or personal data;
- the affected version or commit;
- any suggested fix, if you have one.

## API keys and secrets

This project is a local, single-user tool. It expects a DeepSeek API key in one of two places:

- the page's **API 设置** dialog, held in the Node process memory only;
- a local `.env` file, which is ignored by Git.

Never commit `.env`, paste a key into an issue, or include a key in a screenshot or CI log. If a key is exposed, revoke it in the DeepSeek platform and create a new one immediately.

## Public deployment

The default server binds to `127.0.0.1` and has no multi-user authentication. If you expose it publicly, you are responsible for adding authentication, rate limiting, quota controls, HTTPS, and abuse protection. Do not make `/api/search` publicly reachable with your own API key unless you have those controls in place.
