-- Add optional title columns to notes tables
alter table if exists public.wall_entries
  add column if not exists title text;

alter table if exists public.friend_entries
  add column if not exists title text;

alter table if exists public.tech_notes
  add column if not exists title text;

