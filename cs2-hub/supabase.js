import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm'

const SUPABASE_URL = 'https://yujlmvqxffkojsokcdiu.supabase.co'
const SUPABASE_ANON_KEY = 'sb_publishable_DNPXu4mt3dpTO_vWkXjynA_iok_gcwo'

// Design preview mode: when window.__designMockSupabase is set by _design_mock.js
// (injected before this module loads), use the mock instead of the real client.
// Safe in production — the flag never gets set there.
export const supabase = (typeof window !== 'undefined' && window.__designMockSupabase)
  ? window.__designMockSupabase
  : createClient(SUPABASE_URL, SUPABASE_ANON_KEY)

export function getTeamId() {
  return localStorage.getItem('cs2hub_team_id')
}

export function setTeamId(id) {
  localStorage.setItem('cs2hub_team_id', id)
}

export function clearTeamId() {
  localStorage.removeItem('cs2hub_team_id')
}
