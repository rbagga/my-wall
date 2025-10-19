-- Extend short_links to support friend_entries
do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'short_links' and column_name = 'friend_entry_id'
  ) then
    alter table public.short_links
      add column friend_entry_id bigint references public.friend_entries(id) on delete cascade;
  end if;

  -- Unique index for friend_entry_id (ignore nulls)
  create unique index if not exists short_links_friend_entry_unique
    on public.short_links(friend_entry_id) where friend_entry_id is not null;
end $$;

