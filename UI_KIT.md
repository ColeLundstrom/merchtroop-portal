# Merch Troop Portal — UI Kit

Source of truth for the portal design system. Extracted from `index.html`, `tasks.html`, `login.html`. Use these tokens and component specs when designing new screens or redesigning existing ones.

---

## 1. Brand

- **Product:** Merch Troop Portal (staff-facing ops dashboard)
- **Tone:** Dark-mode first, dense, information-heavy, operator-oriented (not marketing)
- **Vibe:** Bloomberg-terminal-meets-Linear — compact, keyboard-friendly, no wasted pixels
- **Brand color:** Merch Troop orange `#ff9100` — used sparingly as accent, never as a background fill for large areas

---

## 2. Color Tokens

Copy directly into `:root{}`:

```css
--bg:        #0a0e17;               /* app background */
--surface:   #111827;               /* card / panel surface */
--surface2:  #1a2236;               /* raised surface (modals, menus) */
--border:    rgba(255,255,255,.07); /* subtle divider */

--text:      #e8edf5;               /* primary text */
--muted:     #64748b;               /* secondary / labels */

--brand:     #ff9100;               /* Merch Troop orange — accents only */
--red:       #ef4444;               /* urgent / error */
--yellow:    #f59e0b;               /* warning / attention */
--blue:      #3b82f6;               /* info / links */
--green:     #22c55e;               /* success / revenue */
```

### Semantic tinted surfaces (for badges, chips, state highlights)

| Use | Background | Border | Text |
|---|---|---|---|
| Brand-tinted | `rgba(255,145,0,.08)` | `rgba(255,145,0,.25)` | `var(--brand)` |
| Red / urgent | `rgba(239,68,68,.10)` | `rgba(239,68,68,.30)` | `#fca5a5` |
| Yellow / warn | `rgba(245,158,11,.08)` | `rgba(245,158,11,.30)` | `#fcd34d` |
| Blue / info | `rgba(59,130,246,.06)` | `rgba(59,130,246,.25)` | `#93c5fd` |
| Green / good | `rgba(34,197,94,.06)` | `rgba(34,197,94,.25)` | `#86efac` |

Rule: tinted surfaces always pair background + border + text at the opacities above. Don't invent new tint ratios.

---

## 3. Typography

- **Family:** `-apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif`
- **Base size:** 15px / 1.5 line-height
- **No custom web font.** Keep system stack.

### Scale (used throughout)

| Role | Size | Weight | Transform | Color |
|---|---|---|---|---|
| Brand mark | 18px | 800 | — | `--brand` |
| Page section head | 11px | 800 | UPPERCASE, +0.8px letter-spacing | `--muted` |
| KPI value | 20px | 800 | — | colored |
| KPI label | 13px | 400 | — | `--muted` |
| Card title | 15px | 600 | — | `--text` |
| Card sub / meta | 13px | 400 | — | `--muted` |
| Body | 15px | 400 | — | `--text` |
| Small meta / timestamps | 13px | 400 | — | `--muted` |
| Badge | 10px | 700 | — | tinted |
| Button label | 12–13px | 600–700 | — | varies |

---

## 4. Layout

- **Shell max-width:** `960px`, centered, `padding: 0 16px`
- **Background:** `var(--bg)` everywhere, full bleed
- **Header:** sticky, 1px bottom border, 10px vertical padding
- **Vertical rhythm:** sections use 16px top / 8px bottom pad; cards gap 6px; kanban gap 4px
- **Border radius:** `--r: 10px` on cards/panels; 8px on inputs; 6px on small buttons/badges; 99px on pills/chips/avatars

---

## 5. Components

### 5.1 Header Button (`.hBtn`)

```
12px 600, padding 6px 12px, radius 6px
border 1px solid var(--border), background transparent
color var(--muted) → var(--text) on hover
.primary: background var(--brand), color #000 (black text on orange)
```

### 5.2 Action Button (`.actBtn`)

Compact action buttons used inside cards.

```
11px 600, padding 5px 12px, radius 6px
Default: transparent bg, muted text
.claim: blue-tinted
.done:  green-tinted, bold
.send:  brand-tinted, bold
```

### 5.3 Nav Tabs (`.nav` + `.navBtn`)

- Flat row with 1px bottom border on container
- Inactive: 13px 600, muted color
- Active: brand color + 2px brand bottom border (overlapping the container's border)
- Red badge count in top-right corner when items pending

### 5.4 Filter Chip (`.chip`)

Pill-shaped toggles used above lists.

```
12px 600, padding 5px 14px, radius 99px
Off: transparent, border var(--border), color muted
On:  bg rgba(255,145,0,.12), border rgba(255,145,0,.45), text
```

### 5.5 Card (`.card`)

Primary content container — used for tasks, estimates, deals, leads.

- `background: var(--surface)` / `border: 1px solid var(--border)` / radius `--r`
- 3px left accent stripe indicates priority: red=urgent, yellow=attention, blue=normal
- Clickable header row; chevron rotates 90° when expanded
- Expanded body gets a top border and flex-column layout with 14px gap
- Hover raises border opacity to `.14`

### 5.6 Kanban Card (`.kCard`)

Lighter weight card used in the task board.

- Same surface + border
- Radius 8px, padding 10px 12px
- Name 13px/600, job subtext 11px/muted, green revenue + muted due date footer

### 5.7 Event Card (`.evCard`)

- Left date block: month abbreviation (orange, 10px/800), big day number (22px/800), day-of-week (muted)
- Right info: event name 15px/700, client 12px/muted, meta rows
- Staff row: circular 28px dots, filled=green-tinted with initials, empty=muted with `+`
- Past events at `opacity: .45`

### 5.8 Inbox Item (`.inboxItem`)

- Horizontal row with 36px circular brand-tinted avatar (initials)
- Unread state: 3px left brand border
- Name 14px/600, preview 13px/muted/ellipsis, time 13px/muted right-aligned

### 5.9 Input (`.mInput` / `.msgInput` / `.searchBox`)

```
border 1px solid var(--border)
bg rgba(255,255,255,.03) or .04
color var(--text), placeholder var(--muted)
radius 6–8px, padding 8–10px × 10–12px
Focus: border rgba(255,255,255,.2) (or brand ring — see Focus section)
```

### 5.10 Badge

10px 700, padding 2px 7px, radius 4px. Always tinted bg + border + text per §2 semantic palette. Used for: SLA overdue/due soon, wait hot/warm, assigned, flagged, payment required, pipeline stages.

### 5.11 Modal (`.modal`)

```
position: fixed, centered, width min(460px, 94vw)
background #131e30, border 1px rgba(255,255,255,.12)
radius 14px, padding 22px, gap 12px
Overlay: rgba(0,0,0,.6)
Body scrolls at 90vh max height
Actions pinned bottom-right with 10px gap
```

### 5.12 Toast (`.toast`)

Bottom-right stack, 13px, 10px 14px padding, radius 8px, subtle drop shadow. `.ok` green border, `.err` red border + text.

### 5.13 Pipeline Stepper (`.pipe`)

Horizontal stage chain. Done = faded muted, current = brand-tinted pill (bold), todo = muted at 40% opacity. Caret arrows between stages at 9px muted.

### 5.14 Conversation Bubbles (`.convMsg`)

- `.out` (sent): brand-tinted bg, right-aligned
- `.in` (received): blue-tinted bg, left-aligned
- Max-width 85%, 12px text, 8px radius

---

## 6. Interaction & Motion

- **Transition duration:** `.12s` (hover) / `.15s` (layout changes like card expand)
- **Easing:** default browser ease-out is fine; use `ease-out` explicitly for expand animations
- **Spinner:** 14px, 2px border, brand top-color, `.6s` linear infinite
- **Skeleton shimmer:** gradient from 3% → 6% → 3% white alpha, 1.5s linear

---

## 7. Focus States (Accessibility)

All interactive elements must show a 2px brand-colored outline on keyboard focus with 2px offset:

```css
*:focus-visible{outline:2px solid #4A90D9;outline-offset:2px}
.hBtn:focus-visible,.actBtn:focus-visible,.chip:focus-visible,.navBtn:focus-visible,
.mInput:focus-visible,.mTextarea:focus-visible,.mSelect:focus-visible,
.msgInput:focus-visible,.searchBox:focus-visible,.threadInput:focus-visible{
  outline:2px solid var(--brand);outline-offset:2px
}
```

---

## 8. Design Principles

1. **Density over whitespace.** This is an operator tool — operators want to see more, not less. Don't pad like a marketing site.
2. **Orange is the accent, not the wallpaper.** Use `--brand` for primary CTAs, active tab indicators, unread dots, and small highlights. Never as a large background fill.
3. **Tinted states, not solid fills.** Every state (urgent, warn, success, info) uses a low-alpha background + mid-alpha border + bright text.
4. **One primary action per screen.** Everything else is a ghost button or a chip.
5. **Sticky header, scrollable main, fixed toasts.** Don't scroll the whole page; scroll the content region.
6. **No drop shadows on inline elements.** Shadows only on floating surfaces (toasts, menus, modals).
7. **No border-radius above 14px.** Pills (99px) are the only exception.

---

## 9. What NOT to change

- **Calendar / event system** — existing logic works well, don't rewrite.
- **Color tokens** — treat as locked. Don't introduce a new palette.
- **System font stack** — don't add a webfont.
- **Max-width 960px** — the portal is intentionally narrow for operator focus.

Redesign focus areas: dashboard layout, task board UX, calculator polish, inbox density, modal clarity.
