-- Create series and series_items tables to group wall entries
-- Apply with Supabase CLI: `supabase db push`

begin;

-- Create series table (id, title, created_at)
do $$
begin
  if not exists (
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'series'
  ) then
    create table public.series (
      id bigserial primary key,
      title text not null,
      home_wall text not null check (home_wall in ('rishu','friend','tech','songs','ideas')) default 'rishu',
      created_at timestamptz not null default now()
    );
  end if;
end$$;

-- Create series_items table (series_id, source_type, source_id, position, created_at)
do $$
begin
  if not exists (
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'series_items'
  ) then
    create table public.series_items (
      series_id bigint not null references public.series(id) on delete cascade,
      -- source_type identifies which wall the item belongs to
      -- allowed: 'rishu' (wall_entries), 'friend' (friend_entries), 'tech' (tech_notes), 'songs' (song_quotes), 'ideas' (project_ideas)
      source_type text not null check (source_type in ('rishu','friend','tech','songs','ideas')),
      source_id bigint not null,
      position integer,
      created_at timestamptz not null default now(),
      primary key (series_id, source_type, source_id)
    );
  end if;
end$$;

-- Helpful indexes
create index if not exists series_created_at_idx on public.series (created_at desc);
create index if not exists series_home_wall_idx on public.series (home_wall);
create index if not exists series_items_series_pos_idx on public.series_items (series_id, position);
create index if not exists series_items_source_idx on public.series_items (source_type, source_id);

commit;
