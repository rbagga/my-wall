-- Allow short_links rows that point to friend_entries only
do $$
begin
  -- Drop NOT NULL from entry_id if present
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'short_links'
      and column_name = 'entry_id'
      and is_nullable = 'NO'
  ) then
    alter table public.short_links
      alter column entry_id drop not null;
  end if;

  -- Ensure at least one of entry_id or friend_entry_id is set
  alter table public.short_links
    drop constraint if exists short_links_entry_or_friend_chk;
  alter table public.short_links
    add constraint short_links_entry_or_friend_chk
    check (entry_id is not null or friend_entry_id is not null);
end $$;

