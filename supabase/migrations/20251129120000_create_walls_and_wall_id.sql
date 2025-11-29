-- Create walls table and associate wall_entries with a wall via wall_id
do $$ begin
  if not exists (
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'walls'
  ) then
    create table public.walls (
      id bigserial primary key,
      name text not null,
      slug text not null unique,
      created_at timestamptz not null default now()
    );
    create index if not exists walls_created_at_idx on public.walls (created_at desc);
  end if;
end $$;

-- Ensure default wall exists
insert into public.walls (name, slug)
select 'rishu', 'rishu'
where not exists (select 1 from public.walls where slug = 'rishu');

-- Add wall_id column to wall_entries if missing
do $$ begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'wall_entries' and column_name = 'wall_id'
  ) then
    alter table public.wall_entries add column wall_id bigint;
  end if;
end $$;

-- Backfill wall_id to default wall
update public.wall_entries e
set wall_id = (select id from public.walls where slug = 'rishu')
where e.wall_id is null;

-- Add FK and not null constraint, plus index
do $$ begin
  -- add FK if missing
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.wall_entries'::regclass and conname = 'wall_entries_wall_id_fkey'
  ) then
    alter table public.wall_entries
      add constraint wall_entries_wall_id_fkey
      foreign key (wall_id) references public.walls(id) on delete restrict;
  end if;
  -- enforce not null
  alter table public.wall_entries alter column wall_id set not null;
end $$;

create index if not exists wall_entries_wall_id_idx on public.wall_entries (wall_id);

