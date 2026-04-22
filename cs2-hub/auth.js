import { supabase } from './supabase.js'

export async function requireAuth() {
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) {
    window.location.href = 'login.html'
    throw 0
  }
  if (!window.location.pathname.endsWith('team-select.html')) {
    const { getTeamId, clearTeamId } = await import('./supabase.js')
    const teamId = getTeamId()
    if (!teamId) {
      window.location.href = 'team-select.html'
      throw 0
    }
    const { data: membership } = await supabase
      .from('team_members')
      .select('id')
      .eq('team_id', teamId)
      .eq('user_id', session.user.id)
      .maybeSingle()
    if (!membership) {
      clearTeamId()
      window.location.href = 'team-select.html'
      throw 0
    }
  }
  return session
}

export async function signIn(email, password) {
  const { data, error } = await supabase.auth.signInWithPassword({ email, password })
  if (error) throw error
  return data
}

export async function signOut() {
  await supabase.auth.signOut()
  window.location.href = 'login.html'
}

export async function getUser() {
  const { data: { user } } = await supabase.auth.getUser()
  return user
}
