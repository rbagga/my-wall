-- Create short_links table to store short codes for entries
do $$
begin
  if not exists (
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'short_links'
  ) then
    create table public.short_links (
      code text primary key,
      entry_id bigint not null references public.wall_entries(id) on delete cascade,
      created_at timestamp with time zone not null default now()
    );
    create unique index if not exists short_links_entry_unique on public.short_links(entry_id);
  end if;
end $$;

