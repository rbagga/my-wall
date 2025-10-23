-- Create tech_notes table for random tech notes wall
create table if not exists public.tech_notes (
  id bigserial primary key,
  text text not null,
  timestamp timestamptz not null default now()
);

-- Basic index to speed ordering by timestamp
create index if not exists tech_notes_timestamp_idx on public.tech_notes (timestamp desc);

