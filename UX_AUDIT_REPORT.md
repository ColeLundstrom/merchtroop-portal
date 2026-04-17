# Portal UX Benchmark Audit (CRM + Ops Dashboard + Work/Order Tools)

**Scope audited:** `portal/index.html`, `portal/server.mjs`  
**Date:** 2026-03-09  
**Method:** code-level review + UX pattern benchmark against public guidance/pages fetched via `web_fetch`

## External pattern references used

1. Nielsen Norman Group — *10 Usability Heuristics*  
   https://www.nngroup.com/articles/ten-usability-heuristics/
2. Nielsen Norman Group — *Progress Indicators Make a Slow System Less Insufferable*  
   https://www.nngroup.com/articles/progress-indicators/
3. Atlassian Design System — *Empty state*  
   https://atlassian.design/components/empty-state/
4. Atlassian Design System — *Spinner*  
   https://atlassian.design/components/spinner/
5. IBM Carbon Design System — *Empty states pattern*  
   https://carbondesignsystem.com/patterns/empty-states-pattern/

---

## Executive summary

Portal is fast and operationally rich, but UX currently behaves more like an internal engineering console than a production-grade daily operations workspace.

**Main gaps versus mature CRM/ops products:**
- Too many top-level controls competing at once (high orientation cost).
- Feedback exists, but latency/failure states are not structured enough for confident recovery.
- Keyboard/focus/readability ergonomics are below modern business-software baseline.
- Mobile ergonomics are limited for dense task flows.
- Reliability cues (what is stale, what failed, what is retryable) are partial.

---

## Scored rubric (1–10)

### 1) Navigation & information architecture — **6.0 / 10**
**What works**
- Clear primary tabs (Overview, Calculator, Integrations, Logic Mode).
- Global search + scope + urgency + sort + saved views + command palette are powerful for experts.

**Observed frictions**
- Header/control density is very high (multiple filter rows, many similar-priority actions).
- “Logic Mode / Talk to Rosie / Copilot” intent boundaries are not crisp.
- Important daily tasks are not visually elevated above secondary controls.

**Benchmark note**
- NNG heuristic #8 (Aesthetic & Minimalist) and #6 (Recognition vs Recall): too much equal-weight information increases cognitive load.

---

### 2) Readability & accessibility baseline — **4.8 / 10**
**What works**
- Visual hierarchy exists (card titles/meta/chips).
- Dark UI styling is coherent.

**Observed frictions (code evidence)**
- `body` base font-size is 14px; many controls/meta at 11–12px.
- Inputs use `outline:none`; calendar summary explicitly disables focus outline (`summary:focus{outline:none}`).
- Several muted text tokens likely under contrast comfort for long sessions.

**Benchmark note**
- Mature CRM/ops suites prioritize readable dense data + strong focus visibility because keyboard and long-session use are common.

---

### 3) Action latency feedback & system status — **6.4 / 10**
**What works**
- `Sync: refreshing… / OK / paused` pill is good.
- Toasts and row action badges (`pending/success/failed`) exist.
- Periodic refresh and visibility-change handling are implemented.

**Observed frictions**
- Toasts auto-disappear quickly; no persistent operations center with retry context.
- No explicit per-panel loading skeleton/placeholder model.
- Errors collapse to generic strings in list regions, often without remediation buttons.

**Benchmark note**
- NNG progress-indicator guidance: feedback should reduce uncertainty and support longer waits.
- Atlassian spinner guidance: indicate active loading consistently.

---

### 4) Mobile ergonomics — **4.9 / 10**
**What works**
- Responsive rules exist for some grids.
- Toolbar wraps and cards stack.

**Observed frictions**
- Header contains too many controls for small viewports.
- Selection + bulk action workflows are desktop-biased.
- Drawer/command flows do not appear optimized for touch-first progression.

**Benchmark note**
- Mobile ops tooling generally uses “filter sheet + sticky primary actions + card drill-in” rather than full desktop control surfaces.

---

### 5) Workflow clarity (CRM → estimate → production flow) — **6.1 / 10**
**What works**
- Good operational primitives: leads, estimates, paid invoices, calendar, generated follow-ups/plans.
- Inline “Next best action” hints are useful.

**Observed frictions**
- Priority ranking and “what should I do now?” not centralized enough.
- Similar actions appear in multiple places without a single canonical queue.
- Empty/no-data states are mostly passive text, not guided step flows.

**Benchmark note**
- Carbon empty-state pattern: every empty/error state should guide next action in-context.

---

### 6) Reliability cues & trust — **5.5 / 10**
**What works**
- Integrations badge and sync pill provide some status.
- Server has consistent `bad()` envelope (`error`, `details`) and capture timestamps on many endpoints.

**Observed frictions**
- UI doesn’t consistently classify errors into actionable buckets (auth/config/rate-limit/transient/no-data).
- Limited stale-data signaling per card.
- Bulk/action runs are serial and can feel opaque when large.

**Benchmark note**
- NNG heuristics #1 and #9: users need explicit status + recovery path, not raw failure output.

---

## Overall score

**5.6 / 10** (strong capability, moderate usability, weak accessibility/reliability polish)

---

## Top 10 improvements (prioritized by impact/effort)

## 1) Add structured UI state model per card (loading / empty / error / ready)
**Impact:** Very high  
**Effort:** Medium

**Implementation notes**
- **`portal/server.mjs`**: standardize API envelopes to include:
  - `ok`, `status` (`ready|empty|error|stale`), `reasonCode`, `retryable`, `capturedAt`, `nextAction`.
- **`portal/index.html`**:
  - Create `renderState(container, state)` helper.
  - Replace ad-hoc `innerHTML = "...error..."` branches with reusable state blocks including CTA buttons.

---

## 2) Restore focus visibility + raise baseline typography
**Impact:** Very high  
**Effort:** Low

**Implementation notes**
- **`portal/index.html` CSS**:
  - Remove `outline:none` from inputs and `summary:focus{outline:none}`.
  - Add strong `:focus-visible` styles on `.btn, .input, select, summary, .tab, .cmdItem`.
  - Raise body to 15–16px; set minimum meta/input text to 13–14px.

---

## 3) Simplify header controls into progressive disclosure
**Impact:** High  
**Effort:** Medium

**Implementation notes**
- **`portal/index.html`**:
  - Keep primary row: Search, Scope, Urgency, Refresh status.
  - Move sort/saved view/layout reset/quick scope chips into “More filters” collapsible panel or drawer.
  - Persist expanded/collapsed state in localStorage.

---

## 4) Add persistent Action Center (replace toast-only history)
**Impact:** High  
**Effort:** Medium

**Implementation notes**
- **`portal/index.html`**:
  - New panel listing recent operations with status, time, target count, retry button.
  - Keep toasts only as lightweight heads-up.
- **`portal/server.mjs`**:
  - Extend `portal-action-results.json` schema: `startedAt`, `endedAt`, `durationMs`, `retryOf`, `errorClass`.

---

## 5) Introduce bulk-action guardrails (confirm + undo window)
**Impact:** High  
**Effort:** Medium

**Implementation notes**
- **`portal/index.html`**:
  - Before `runActionBatch`, show confirm modal: action type + selected count + sample records.
  - Add 8–10s undo/cancel for queued actions not yet started.
- **`portal/server.mjs`**:
  - Support optional dry-run preview endpoint (`/api/actions/preview`) and cancellation token for queued runs.

---

## 6) Make sync reliability explicit per section
**Impact:** High  
**Effort:** Medium

**Implementation notes**
- **`portal/server.mjs`**:
  - Include `capturedAt`, `source`, `freshnessSec`, and `stale` boolean for each integration endpoint.
- **`portal/index.html`**:
  - Render per-card freshness badge (“Live 25s ago”, “Stale 8m”, “Retrying…”).
  - On stale/error, show inline retry button that targets only that card.

---

## 7) Build guided empty/error content with next-step actions
**Impact:** Medium-high  
**Effort:** Medium

**Implementation notes**
- Pattern from Atlassian/Carbon: title + short body + primary action + optional docs/help link.
- **`portal/index.html`**: replace strings like “Leads not available: …” with semantic blocks:
  - “GHL not connected” → “Check integration” CTA
  - “No leads in stage” → “Open pipeline” CTA
  - “Rate limited” → “Retry in 30s” CTA

---

## 8) Create mobile “Ops compact mode”
**Impact:** Medium-high  
**Effort:** Medium-high

**Implementation notes**
- **`portal/index.html`**:
  - Breakpoint mode with sticky bottom action bar (Filter, Search, Bulk actions).
  - Convert dense row action clusters into overflow menu.
  - Increase touch targets and spacing for row controls.

---

## 9) Unify assistant surfaces (Logic/Copilot/Talk to Rosie)
**Impact:** Medium  
**Effort:** Medium

**Implementation notes**
- **`portal/index.html`**:
  - Rename to single “Assistant” surface with tabs inside (Ask, Automations, Recent outputs).
  - Reuse one composer and one history component.
- **`portal/server.mjs`**:
  - Tag messages with `channel`/`intent` metadata for clearer display and filtering.

---

## 10) Increase perceived speed with skeletons + optimistic row updates
**Impact:** Medium  
**Effort:** Medium

**Implementation notes**
- **`portal/index.html`**:
  - Add 2–3 reusable skeleton templates for list cards.
  - On action start, optimistically mark row badge pending immediately (already partly present), then resolve with richer outcome text.
- **`portal/server.mjs`**:
  - Return incremental progress for batch actions (`processed`, `total`, `currentTarget`) if converted to async job model later.

---

## Suggested implementation sequence (fastest value)

### Week 1
1. Focus + typography patch
2. Structured empty/error blocks for leads/estimates/paid/calendar
3. Header simplification (hide advanced controls by default)

### Week 2
4. Persistent Action Center
5. Bulk confirm + undo
6. Per-card freshness and retry

### Week 3+
7. Mobile compact mode
8. Assistant surface unification
9. Async job/progress model for larger action batches

---

## Code hotspots to edit first

### `portal/index.html`
- CSS near top: focus, typography, muted contrast tokens, mobile spacing
- `loadOverview()` + card rendering catch blocks: centralize into `renderState(...)`
- `showToast`, `runActionBatch`, `loadActionResults`: evolve into persistent action center
- Toolbar markup: move secondary controls into collapsible advanced panel

### `portal/server.mjs`
- `bad()` + endpoint responses: normalize envelope with `reasonCode/retryable/capturedAt`
- `/api/actions/run`: include richer per-item status metadata
- integration endpoints (`/api/ghl/*`, `/api/calendar/upcoming`): add explicit freshness/staleness contract

---

## Final assessment

This portal is close to “excellent internal ops cockpit” quality. The biggest wins now are **clarity, accessibility, and trust signaling**, not new feature surface area. With the top 10 changes above, the experience should move from **5.6/10** to roughly **7.5–8.0/10** for daily CRM + operations work.