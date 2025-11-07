-- Create project_ideas table for project ideas wall
do $$ begin
  if not exists (
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'project_ideas'
  ) then
    create table public.project_ideas (
      id bigserial primary key,
      text text not null,
      title text null,
      timestamp timestamptz not null default now()
    );
  end if;
end $$;

-- Index to fetch newest first
create index if not exists project_ideas_timestamp_idx on public.project_ideas (timestamp desc);

