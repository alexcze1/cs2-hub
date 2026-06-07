// Scrim finder (#62) — small board where teams post a time window
// they're available to scrim and discover open listings within the
// last 7 days. MVP: free-text fields (time slot, maps, rank range,
// note); no auto-matching, no DM system. Discord link goes in the
// note field for now.
//
// Backed by scrim_listings (see supabase-scrim-finder-migration.sql).
// All teams on the platform can read listings; only the listing
// owner's team can edit/delete.

import { requireAuth } from './auth.js'
import { renderSidebar } from './layout.js'
import { supabase, getTeamId } from './supabase.js'
import { toast } from './toast.js'

function esc(s) { const d = document.createElement('div'); d.textContent = s ?? ''; return d.innerHTML }

await requireAuth()
renderSidebar('schedule')

const teamId = getTeamId()
const formEl   = document.getElementById('sf-listing-form')
const listEl   = document.getElementById('sf-listings')
const postBtn  = document.getElementById('sf-post-btn')
const saveBtn  = document.getElementById('sf-save')
const cancelBtn = document.getElementById('sf-cancel')

postBtn.addEventListener('click', () => { formEl.style.display = 'block' })
cancelBtn.addEventListener('click', () => { formEl.style.display = 'none' })

saveBtn.addEventListener('click', async () => {
  const date  = document.getElementById('sf-date').value
  const time  = document.getElementById('sf-time').value.trim()
  const maps  = document.getElementById('sf-maps').value.trim()
  const rank  = document.getElementById('sf-rank').value.trim()
  const note  = document.getElementById('sf-note').value.trim()
  if (!date || !time) { toast('Date and time slot required.', 'error'); return }
  const { data: { user } } = await supabase.auth.getUser()
  const { error } = await supabase.from('scrim_listings').insert({
    team_id: teamId,
    posted_by: user?.id,
    listing_date: date,
    time_slot: time,
    maps: maps || null,
    rank_range: rank || null,
    note: note || null,
  })
  if (error) { toast(`Could not post listing — apply supabase-scrim-finder-migration.sql?`, 'error'); return }
  formEl.style.display = 'none'
  toast('Listing posted.')
  loadListings()
})

async function loadListings() {
  const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
  const { data, error } = await supabase
    .from('scrim_listings')
    .select('id, team_id, listing_date, time_slot, maps, rank_range, note, posted_by, created_at, teams(name)')
    .gte('created_at', cutoff)
    .order('listing_date', { ascending: true })
  if (error) {
    listEl.innerHTML = `<div class="empty-state-art">
      <div class="empty-state-art-icon">!</div>
      <div class="empty-state-art-title">Scrim Finder isn't set up yet</div>
      <div class="empty-state-art-sub">Apply supabase-scrim-finder-migration.sql to your Supabase project to enable cross-team listings.</div>
    </div>`
    return
  }
  if (!data?.length) {
    listEl.innerHTML = `<div class="empty-state-art">
      <div class="empty-state-art-icon">·</div>
      <div class="empty-state-art-title">No listings posted yet</div>
      <div class="empty-state-art-sub">Click "+ Post listing" to put your team's availability on the board.</div>
    </div>`
    return
  }
  const { data: { user } } = await supabase.auth.getUser()
  listEl.innerHTML = `
    <div class="sf-list">
      ${data.map(r => {
        const teamName = r.teams?.name || 'A team'
        const date = new Date(r.listing_date).toLocaleDateString('en-GB', { weekday:'short', day:'numeric', month:'short' })
        const mine = r.posted_by === user?.id
        return `
          <div class="sf-row ${mine ? 'sf-row-mine' : ''}">
            <div class="sf-when">
              <div class="sf-date">${esc(date)}</div>
              <div class="sf-time">${esc(r.time_slot)}</div>
            </div>
            <div class="sf-team">
              <div class="sf-team-name">${esc(teamName)}${mine ? ' <span class="sf-mine-pill">YOU</span>' : ''}</div>
              ${r.rank_range ? `<div class="sf-rank">${esc(r.rank_range)}</div>` : ''}
            </div>
            <div class="sf-maps">${esc(r.maps ?? 'any maps')}</div>
            <div class="sf-note">${esc(r.note ?? '')}</div>
            ${mine ? `<button class="sf-delete" data-id="${r.id}" title="Delete">×</button>` : '<span></span>'}
          </div>`
      }).join('')}
    </div>`
  listEl.querySelectorAll('.sf-delete').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm('Remove this listing?')) return
      await supabase.from('scrim_listings').delete().eq('id', btn.dataset.id)
      loadListings()
    })
  })
}

loadListings()
