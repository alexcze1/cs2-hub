// _build_preview.mjs — generates _preview/<page>.html for visual screenshots.
// Each preview HTML injects _design_mock.js (sets window.__designMockSupabase) BEFORE
// the page's module scripts, so all supabase + auth calls return fake data.
//
// Run:  node _build_preview.mjs

import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import { join, dirname, relative } from 'path'

const ROOT = '.'
const OUT = '_preview'

const PAGES = [
  'dashboard.html',
  'schedule.html',
  'stratbook.html',
  'stratbook-detail.html',
  'vods.html',
  'vod-detail.html',
  'demos.html',
  'analysis.html',
  'opponents.html',
  'opponent-detail.html',
  'veto.html',
  'keywords.html',
  'goals.html',
  'issues.html',
  'roster.html',
  'admin.html',
  'team-select.html',
  'login.html',
]

if (!existsSync(OUT)) mkdirSync(OUT)

// Inject the mock script BEFORE the first <script type="module"> (since module
// scripts are deferred, an inline classic script always runs first).
// We also bump asset URLs to be relative-to-parent (../images/...) since the
// preview files live in /_preview/.

function patchHTML(html) {
  // Use <base href="../"> so ALL relative URLs (including ones injected by JS like
  // images/logo-lettering.png) resolve against the cs2-hub root.
  // Insert it as the FIRST element inside <head> so it applies before any other tag.
  let out = html
  const base = '<base href="../">'
  const mock = '<script src="_design_mock.js"></script>'

  out = out.replace(/<head>/i, `<head>\n  ${base}\n  ${mock}`)
  return out
}

for (const page of PAGES) {
  const src = join(ROOT, page)
  if (!existsSync(src)) continue
  const html = readFileSync(src, 'utf8')
  const patched = patchHTML(html)
  writeFileSync(join(OUT, page), patched)
  console.log('Built', page)
}
console.log('\nDone.  Open: http://localhost:8765/_preview/<page>.html')
