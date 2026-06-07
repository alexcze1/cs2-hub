-- Scrim finder (#62)
-- Cross-team board where any team can post availability and any team
-- can discover open listings. Idempotent.

create table if not exists scrim_listings (
  id           uuid primary key default gen_random_uuid(),
  team_id      uuid not null references teams(id) on delete cascade,
  posted_by    uuid references auth.users(id),
  listing_date date not null,
  time_slot    text not null,
  maps         text,
  rank_range   text,
  note         text,
  created_at   timestamptz default now()
);
create index if not exists idx_scrim_listings_date on scrim_listings(listing_date);
create index if not exists idx_scrim_listings_created on scrim_listings(created_at desc);

alter table scrim_listings enable row level security;

-- Everyone authenticated can SEE every listing (the whole point — the
-- board has to be cross-team). Posting and deleting are scoped to
-- the listing's owning team.
drop policy if exists "scrim_listings_select_all" on scrim_listings;
create policy "scrim_listings_select_all" on scrim_listings
  for select to authenticated using (true);

drop policy if exists "scrim_listings_insert_own" on scrim_listings;
create policy "scrim_listings_insert_own" on scrim_listings
  for insert to authenticated
  with check (
    team_id in (select team_id from team_members where user_id = auth.uid())
    and posted_by = auth.uid()
  );

drop policy if exists "scrim_listings_delete_own" on scrim_listings;
create policy "scrim_listings_delete_own" on scrim_listings
  for delete to authenticated
  using (
    posted_by = auth.uid()
    or exists (
      select 1 from teams t where t.id = scrim_listings.team_id and t.owner_id = auth.uid()
    )
  );
