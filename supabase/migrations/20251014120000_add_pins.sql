-- Adds pinning columns and index for wall entries
-- Apply with Supabase CLI: `supabase db push` (after linking project)

begin;

-- Add is_pinned column if missing
do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'wall_entries'
      and column_name = 'is_pinned'
  ) then
    alter table public.wall_entries
      add column is_pinned boolean not null default false;
  end if;
end$$;

-- Add pin_order column if missing
do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'wall_entries'
      and column_name = 'pin_order'
  ) then
    alter table public.wall_entries
      add column pin_order integer;
  end if;
end$$;

-- Index to speed up pinned-first queries
create index if not exists wall_entries_pinned_order_idx
  on public.wall_entries (is_pinned, pin_order);

commit;

