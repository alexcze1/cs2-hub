// cs2-hub/auth.js — DEMO MODE (replace supabase.js with real credentials for production)
import { supabase } from './supabase.js'

export async function requireAuth() {
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) {
    window.location.href = 'index.html'
    return null
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
