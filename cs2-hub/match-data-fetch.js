import { supabase } from './supabase.js'

// match_data lives in Supabase Storage as a gzipped JSON file because pushing
// 40+ MB of jsonb through the pooler from the parser VPS was hitting the 240 s
// asyncio cap before the UPDATE could finish. The path is on demos.match_data_url
// (e.g. '{team_id}/{demo_id}.json.gz' or 'public/{demo_id}.json.gz').
//
// Callers should SELECT match_data_url (not match_data) and pass the row here.
// A pre-migration row with match_data jsonb still inline takes the fast path.

export async function loadMatchData(demoRow) {
  if (!demoRow) return null
  if (demoRow.match_data) return demoRow.match_data
  if (!demoRow.match_data_url) return null
  const { data: blob, error } = await supabase.storage
    .from('match-data')
    .download(demoRow.match_data_url)
  if (error || !blob) {
    console.warn('[match-data] download failed for', demoRow.id, error)
    return null
  }
  const stream = blob.stream().pipeThrough(new DecompressionStream('gzip'))
  const text = await new Response(stream).text()
  return JSON.parse(text)
}

export async function hydrateMatchData(demos) {
  await Promise.all(demos.map(async d => {
    if (!d.match_data) d.match_data = await loadMatchData(d)
  }))
  return demos
}
