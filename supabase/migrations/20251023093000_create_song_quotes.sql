-- Create song_quotes table for song quotes wall
do $$ begin
  if not exists (
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'song_quotes'
  ) then
    create table public.song_quotes (
      id bigserial primary key,
      text text not null,
      title text null,
      spotify_url text null,
      timestamp timestamptz not null default now()
    );
  end if;
end $$;

-- Index to fetch newest first
create index if not exists song_quotes_timestamp_idx on public.song_quotes (timestamp desc);
