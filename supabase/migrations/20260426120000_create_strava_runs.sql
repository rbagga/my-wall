-- Cache Strava connection metadata and synced runs locally
do $$ begin
  if not exists (
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'strava_connections'
  ) then
    create table public.strava_connections (
      id bigserial primary key,
      athlete_id bigint not null unique,
      athlete_username text null,
      athlete_firstname text null,
      athlete_lastname text null,
      access_token text not null,
      refresh_token text not null,
      token_type text null,
      expires_at bigint not null,
      scope text null,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
  end if;
end $$;

create index if not exists strava_connections_athlete_id_idx
  on public.strava_connections (athlete_id);

do $$ begin
  if not exists (
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'strava_runs'
  ) then
    create table public.strava_runs (
      id bigserial primary key,
      strava_id bigint not null unique,
      name text not null,
      description text null,
      sport_type text null,
      start_date timestamptz not null,
      timezone text null,
      distance_meters double precision null,
      moving_time_seconds integer null,
      elapsed_time_seconds integer null,
      total_elevation_gain double precision null,
      average_speed double precision null,
      average_heartrate double precision null,
      suffer_score double precision null,
      map_summary_polyline text null,
      map_polyline text null,
      external_url text null,
      synced_at timestamptz not null default now(),
      raw jsonb null
    );
  end if;
end $$;

create index if not exists strava_runs_start_date_idx
  on public.strava_runs (start_date desc);
