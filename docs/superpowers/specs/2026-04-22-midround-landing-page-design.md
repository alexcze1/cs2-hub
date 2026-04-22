# MIDROUND Landing Page — Design Spec

**Date:** 2026-04-22  
**File:** `cs2-hub/landing.html`  
**Status:** Approved

---

## Purpose

A standalone marketing page that converts leads (pro and upcoming CS2 teams) into waitlist signups. It displays the product, communicates prestige, and gates access behind a "Request Access" form to maintain exclusivity.

---

## Audience

Pro CS2 teams and serious upcoming teams. They respond to atmosphere and professionalism over feature checklists. The page must feel like a tool built at their level.

---

## CTA Mechanic

**Request Access (waitlist).** Users submit their email. No immediate access — reinforces exclusivity. Form collects email only. Submission shows a confirmation message in-place (no redirect). Client-side only — no backend or third-party form service. The submitted email is not stored; the mechanic exists purely for UX/conversion signalling.

---

## Aesthetic

- **Background:** `#05080f` — darker than the app's `#080c14`
- **Grain overlay:** Fixed `<div>` with SVG noise texture at ~4% opacity, covers full page, pointer-events none
- **Blue glow:** Radial gradient `rgba(59,130,246,0.12)` behind hero and CTA sections
- **Typography:** Barlow Condensed (Google Fonts, weights 600+700) for all headlines — tall, sharp, uppercase. Segoe UI / system-ui for body and UI mocks.
- **Accent color:** `#3b82f6` — same as app, used sparingly (buttons, badges, glows)
- **Motion:** Intersection Observer fade+slide-up on each section as it enters the viewport. Nav gains backdrop-blur on scroll.

---

## Page Structure

### 1. Nav (fixed)
- Left: MIDROUND logo image (`images/logo-lettering.png`, inverted, ~130px wide)
- Right: "Request Access" pill button (accent bg) — smooth-scrolls to waitlist section
- Default: transparent bg
- On scroll (>60px): `background: rgba(5,8,15,0.85)` + `backdrop-filter: blur(12px)` + bottom border

### 2. Hero (full viewport, centered)
- Faint dot-grid background + blue radial glow center
- MIDROUND logo image, large (~200px)
- Headline (Barlow Condensed, ~68px uppercase): **"THE PLATFORM SERIOUS CS2 TEAMS USE."**
- Sub (small caps, muted, 14px): `Stratbook · Antistrat · VOD Review · Schedule`
- CTA button: "Request Access →" (accent, smooth-scroll to waitlist)
- Scroll hint: small animated chevron at bottom

### 3. Feature — Stratbook + Match View
- Two-column layout: mock UI left, copy right
- Mock: 3–4 styled strat cards (T/CT badge, map chip, role rows, strat name)
- Headline: **"EVERY PLAY. ORGANIZED."**
- Body: 2 sentences about stratbook + match view fullscreen mode
- Section bg: `#07090f`, subtle left-edge blue glow behind mock panel

### 4. Feature — Antistrat + Print
- Flipped: copy left, mock right
- Mock: antistrat gameplan sheet (CT/T split panels, positions label, tendencies, solutions — matching app's `.gameplan-sheet` visual style)
- Headline: **"KNOW YOUR ENEMY BEFORE THE SERVER LOADS."**
- Body: 2 sentences, mention print-to-PDF for in-person use
- Section bg: `#060810`

### 5. Feature — Results & VOD Review
- Two-column: mock left, copy right
- Mock: match result row (map name, score, W/L chip) + 2–3 timestamped VOD note lines
- Headline: **"REVIEW EVERY MAP. LEARN FROM EVERY LOSS."**
- Body: 2 sentences about structured post-match review
- Section bg: `#07090f`

### 6. Feature — Schedule
- Full-width mock: 7-column week strip (Mon–Sun) with sample events (SCRIM, VOD REVIEW badges)
- Below strip: two small integration badges — pracc.com logo text + Google Calendar icon
- Headline above: **"EVERY SCRIM, TOURNAMENT, AND MEETING — IN ONE PLACE."**
- Body: 1 sentence mentioning pracc.com and Google Calendar sync
- Section bg: `#060810`

### 7. Waitlist CTA
- Full bleed, centered, blue radial glow
- Large headline (Barlow Condensed, ~56px): **"BUILT FOR TEAMS THAT TAKE IT SERIOUSLY."**
- Email input + "Request Access" button side-by-side (stacks on mobile)
- Small note below: `We onboard teams by invite. No spam.`
- On submit: input + button replaced by `✓ You're on the list. We'll be in touch.`

### 8. Footer
- Logo (small, inverted) left
- `© MIDROUND 2026` right
- Minimal, dark, 1px top border

---

## Animations

- **Entry:** Each section's content fades in and slides up 20px as it enters the viewport (Intersection Observer, threshold 0.15, `animation-fill-mode: both`, staggered children via `animation-delay`)
- **Nav:** Smooth backdrop transition on scroll (requestAnimationFrame listener)
- **Hero chevron:** CSS keyframe bounce

---

## Files Affected

| File | Action |
|------|--------|
| `cs2-hub/landing.html` | Create — full standalone page |

No changes to `style.css`, `index.html`, or any app JS. The landing page is fully self-contained with its own `<style>` block and inline script.

---

## Out of Scope

- Real screenshots (mocks are styled HTML)
- Backend waitlist storage (client-side confirmation only)
- Mobile-specific breakpoints beyond basic stacking (desktop-first)
- Any navigation links beyond "Request Access"
