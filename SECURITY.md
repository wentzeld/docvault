# Security Policy

## Supported versions

DocVault is developed on the `main` branch, and security fixes are applied
there. We support the latest released `1.x` line.

| Version | Supported |
| ------- | --------- |
| 1.x     | Yes       |
| < 1.0   | No        |

## Reporting a vulnerability

Please report security vulnerabilities **privately** — do not open a public
GitHub issue for them.

Email: **iseearedduck at duck dot com**

> Maintainers: replace the address above with a real, monitored security
> contact before publishing this repository.

Include as much detail as you can: affected version/commit, a description of
the issue, reproduction steps, and any potential impact. We aim to acknowledge
reports within a few business days and will keep you updated on remediation.

Please give us reasonable time to investigate and release a fix before any
public disclosure.

## Network & trust model

DocVault is designed to run on a **private network** — for example behind
[Tailscale](https://tailscale.com/) or another trusted/WireGuard-style overlay.

- Running over **plain HTTP is acceptable only on a trusted private network**
  (e.g. a Tailscale tailnet, where traffic is already encrypted in transit).
- If you expose DocVault to the public internet, **always put it behind HTTPS**
  (a reverse proxy such as Caddy or nginx terminating TLS). Do not serve the
  API over plain HTTP on a public address.
- The API binds to `127.0.0.1` by default (`DOCVAULT_SERVER_HOST`). Only widen
  the bind address when something in front of it (reverse proxy / private
  network) controls who can reach it.

## Hardening checklist

- [ ] **Set `DOCVAULT_AUTH_SECRET_KEY`** to a strong random value
      (`openssl rand -hex 32`). Sessions/tokens depend on it — never run with an
      empty or default key.
- [ ] **`chmod 600 .env`** so credentials and secrets are not world-readable.
- [ ] **Set `DOCVAULT_WORKER_TOKEN`** whenever the worker port (default `8001`)
      is reachable by anyone other than the API on `localhost`.
- [ ] **Scope API tokens minimally** — grant only the `read`, `write`, or
      `admin` scopes a given bot or integration actually needs.
- [ ] Use a strong, unique PostgreSQL password (`DOCVAULT_DATABASE_URL`) and do
      not expose the database port publicly.
- [ ] Keep dependencies up to date and rebuild after pulling security fixes.
