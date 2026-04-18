-- cs2-hub/supabase-setup.sql
-- Run this entire file in Supabase SQL Editor (supabase.com → your project → SQL Editor)

create table events (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  type text not null check (type in ('scrim','tournament','meeting','vod_review')),
  date timestamptz not null,
  opponent text,
  notes text,
  created_at timestamptz default now(),
  created_by uuid references auth.users(id)
);

create table strats (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  map text not null check (map in ('mirage','inferno','nuke','anubis','dust2','vertigo','ancient')),
  side text not null check (side in ('t','ct')),
  type text not null check (type in ('execute','default','setup','fake','eco','other')),
  player_roles jsonb not null default '[]',
  notes text,
  tags text[] default '{}',
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  created_by uuid references auth.users(id)
);

create table vods (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  result text check (result in ('win','loss','draw')),
  score text,
  match_type text check (match_type in ('scrim','tournament','pug')),
  demo_link text,
  match_date date,
  notes jsonb default '[]',
  created_at timestamptz default now(),
  created_by uuid references auth.users(id)
);

create table opponents (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  favored_maps text[] default '{}',
  strengths text[] default '{}',
  weaknesses text[] default '{}',
  anti_strat text,
  notes text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table roster (
  id uuid primary key default gen_random_uuid(),
  username text not null,
  real_name text,
  role text check (role in ('IGL','AWPer','Entry','Support','Lurker')),
  user_id uuid references auth.users(id)
);

-- Enable RLS
alter table events enable row level security;
alter table strats enable row level security;
alter table vods enable row level security;
alter table opponents enable row level security;
alter table roster enable row level security;

-- Full access for any authenticated user
create policy "auth_all" on events    for all to authenticated using (true) with check (true);
create policy "auth_all" on strats    for all to authenticated using (true) with check (true);
create policy "auth_all" on vods      for all to authenticated using (true) with check (true);
create policy "auth_all" on opponents for all to authenticated using (true) with check (true);
create policy "auth_all" on roster    for all to authenticated using (true) with check (true);
