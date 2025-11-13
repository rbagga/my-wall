-- Add home_wall to series to scope a series to a wall for display
-- Safe to run multiple times; no-ops if already present or table missing.

begin;

do $$
declare
  has_table boolean;
  has_col boolean;
  chk_exists boolean;
begin
  select exists (
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'series'
  ) into has_table;
  if not has_table then
    return;
  end if;

  select exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'series' and column_name = 'home_wall'
  ) into has_col;

  if not has_col then
    alter table public.series add column home_wall text;
    update public.series set home_wall = 'rishu' where home_wall is null;
    alter table public.series alter column home_wall set not null;
    -- Add check constraint if missing
    select exists (
      select 1 from pg_constraint
      where conrelid = 'public.series'::regclass
        and contype = 'c'
        and conname = 'series_home_wall_chk'
    ) into chk_exists;
    if not chk_exists then
      alter table public.series
        add constraint series_home_wall_chk
        check (home_wall in ('rishu','friend','tech','songs','ideas'));
    end if;
    create index if not exists series_home_wall_idx on public.series (home_wall);
  end if;
end $$;

commit;

