-- Add is_public flag to walls for public/private visibility
do $$ begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'walls' and column_name = 'is_public'
  ) then
    alter table public.walls add column is_public boolean not null default true;
  end if;
end $$;

create index if not exists walls_is_public_idx on public.walls (is_public);

