-- Alter series_items to support all walls via polymorphic association
-- Converts from (series_id, entry_id) -> (series_id, source_type, source_id)
-- Safe to run multiple times; no-ops if already migrated or table missing.

begin;

-- Only proceed if table exists and legacy column present
do $$
declare
  has_table boolean;
  has_entry_id boolean;
  has_source_type boolean;
  pk_name text;
  chk_exists boolean;
begin
  select exists (
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'series_items'
  ) into has_table;

  if not has_table then
    -- Nothing to do
    return;
  end if;

  select exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'series_items' and column_name = 'entry_id'
  ) into has_entry_id;

  select exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'series_items' and column_name = 'source_type'
  ) into has_source_type;

  -- Only migrate if we still have entry_id and no source_type
  if has_entry_id and not has_source_type then
    -- Add new columns
    alter table public.series_items add column source_type text;
    alter table public.series_items add column source_id bigint;

    -- Populate from legacy data: assume legacy items came from main wall
    update public.series_items set source_type = 'rishu', source_id = entry_id where source_type is null;

    -- Enforce not null
    alter table public.series_items alter column source_type set not null;
    alter table public.series_items alter column source_id set not null;

    -- Add check constraint for allowed source types, if missing
    select exists (
      select 1 from pg_constraint
      where conrelid = 'public.series_items'::regclass
        and contype = 'c'
        and conname = 'series_items_source_type_chk'
    ) into chk_exists;
    if not chk_exists then
      alter table public.series_items
        add constraint series_items_source_type_chk
        check (source_type in ('rishu','friend','tech','songs','ideas'));
    end if;

    -- Drop existing primary key (name unknown)
    select conname into pk_name
    from pg_constraint
    where conrelid = 'public.series_items'::regclass
      and contype = 'p'
    limit 1;
    if pk_name is not null then
      execute format('alter table public.series_items drop constraint %I', pk_name);
    end if;

    -- Create new composite primary key
    alter table public.series_items
      add primary key (series_id, source_type, source_id);

    -- Drop legacy column (cascades any dependent FKs/idx)
    alter table public.series_items drop column entry_id cascade;

    -- Helpful indexes
    create index if not exists series_items_series_pos_idx on public.series_items (series_id, position);
    create index if not exists series_items_source_idx on public.series_items (source_type, source_id);
  end if;
end $$;

commit;

