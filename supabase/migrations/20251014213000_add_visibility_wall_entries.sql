-- Adds visibility column to wall entries for draft/public
-- Apply with Supabase CLI: `supabase db push`

do $$
begin
  -- Add visibility column if it doesn't exist
  if not exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'wall_entries'
      and column_name = 'visibility'
  ) then
    alter table public.wall_entries
      add column visibility text not null default 'public' check (visibility in ('public','draft'));
  end if;

  -- Backfill any nulls to 'public' (safety in case of prior inconsistent data)
  update public.wall_entries set visibility = 'public' where visibility is null;

  -- Helpful index for filtering by visibility
  create index if not exists wall_entries_visibility_idx on public.wall_entries (visibility);
end $$;

