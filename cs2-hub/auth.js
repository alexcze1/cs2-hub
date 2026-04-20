import { supabase } from './supabase.js'

export async function requireAuth() {
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) {
    window.location.href = 'index.html'
    throw 0
  }
  if (!window.location.pathname.endsWith('team-select.html')) {
    const { getTeamId } = await import('./supabase.js')
    if (!getTeamId()) {
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
  window.location.href = 'index.html'
}

export async function getUser() {
  const { data: { user } } = await supabase.auth.getUser()
  return user
}
