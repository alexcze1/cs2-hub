# Auto-Roster E2E Manual Checklist (2026-05-08)

Run all 7 scenarios end-to-end before declaring the feature shipped.

## 1. Fresh user joins via team code
- [ ] Sign out. Steam-login as a NEW user (or one not in any team).
- [ ] Lands on `team-select.html`.
- [ ] Enter the owner's team join code, fill display name, click Join.
- [ ] Redirects to `dashboard.html`.
- [ ] Open `roster.html` — your row appears with role `Unassigned`, status `MEMBER`.

## 2. Owner promotes new member
- [ ] Sign in as owner. Open `roster.html`.
- [ ] Find the `Unassigned` row from step 1; change role dropdown to `IGL`.
- [ ] Toast: "Role updated".
- [ ] Reload — role persists.
- [ ] Open `vods.html` — the player appears in the "Roster · Career Stats" band (rating may be `—` if no demos yet).

## 3. Owner adds a ghost player
- [ ] On `roster.html` as owner: click "+ Add ghost player".
- [ ] Enter username `ScoutPick`, Steam64 `76561198000000123` (or any valid Steam64), role `AWPer`. Click Add.
- [ ] Toast: "Ghost player added". Form closes.
- [ ] New card appears with `PENDING` badge.

## 4. Ghost merges on Steam-login
- [ ] Sign out. Steam-login as the user matching the Steam64 from step 3.
- [ ] On `team-select.html`, join the same team via code.
- [ ] Reload `roster.html`. Sign in as owner.
- [ ] The ghost row's `PENDING` badge has changed to `MEMBER`.
- [ ] Role is still `AWPer` (preserved through merge).
- [ ] No duplicate row exists for that Steam64.

## 5. Owner removes a real member
- [ ] As owner: click × on a real member's card. Confirm.
- [ ] Toast: "Member removed".
- [ ] Card disappears.
- [ ] Verify in Supabase: `team_members` row gone, `roster` row gone.

## 6. Owner removes a ghost
- [ ] As owner: re-add a ghost. Click × on it. Confirm.
- [ ] Toast: "Ghost removed".
- [ ] Card disappears.
- [ ] `team_members` is unchanged (no row was ever created for the ghost).

## 7. Non-owner write attempts blocked by RLS
- [ ] Sign in as a non-owner team member.
- [ ] Open `roster.html`. Confirm role is a static badge (not a dropdown), no × buttons, no Add ghost button.
- [ ] Open browser DevTools console. Run:
  ```js
  const { supabase } = await import('./supabase.js')
  await supabase.from('roster').update({ role: 'IGL' }).eq('id', '<some-roster-id>')
  ```
  Expected: error or zero rows updated. RLS blocks the write.
