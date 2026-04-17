# Merch Troop Portal

Internal operations portal for Merch Troop (custom apparel printing). Live at `portal.screenprintai.com`.

## Purpose

Staff-facing dashboard for estimates, events, tasks, leads, and production tracking. Integrates with GoHighLevel (GHL), Slack, and internal automations.

## Stack

- **Backend:** Node.js (ESM) — single-file server at `server.mjs`
- **Frontend:** Static HTML + vanilla JS (`index.html`, `login.html`, `tasks.html`, `calculator-v3.html`)
- **Runtime:** `systemd` on Ubuntu VPS as `rosieadmin`
- **Reverse proxy:** nginx → `:3000`

## Files

| File | Role |
|---|---|
| `server.mjs` | Main server — routes, auth, GHL/Slack integrations, APIs |
| `index.html` | Main dashboard (KPIs, events, estimates, Lead ROI, schedule) |
| `login.html` | Session login |
| `tasks.html` | Kanban task board |
| `calculator-v3.html` / `calculator.js` | Estimate/pricing calculator |
| `request-access.html` | Access request form |
| `serve.sh` | Dev server launcher |
| `UX_AUDIT_REPORT.md` | Prior UX audit notes |
| `archive/` | Previous versions of `index.html` for reference |

## Auth

Cookie-based sessions (`portal_session=<token>`) or `Authorization: Bearer <token>`. Users defined in `server.mjs`; password hashes are SHA256.

## External dependencies (not in repo)

Server reads at runtime from the VPS filesystem:
- `~/.openclaw/workspace/projects/ghl/ghl.token.json` — GHL OAuth token
- `~/.openclaw/workspace/config.yaml` — Slack bot token, other channel config

## Key API routes

- `POST /api/draft/followup` — Ollama-backed draft generator
- `GET  /api/lead-sources` — Lead source ROI data
- `POST /api/ghl/send-sms` — Send SMS via GHL
- `POST /api/estimates/create` — Create GHL estimate

## Notes for design work

The calendar/event system is intentionally kept as-is — do not rewrite it. Focus redesign on the main dashboard layout, task board UX, and calculator polish.
