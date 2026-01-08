-- Add is_pinned and pin_order to series (idempotent)
do $$
begin
  if exists (
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'series'
  ) then
    if not exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'series' and column_name = 'is_pinned'
    ) then
      alter table public.series add column is_pinned boolean default false;
      update public.series set is_pinned = false where is_pinned is null;
    end if;
    if not exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'series' and column_name = 'pin_order'
    ) then
      alter table public.series add column pin_order integer;
    end if;
    -- Helpful indexes
    create index if not exists series_is_pinned_idx on public.series (is_pinned);
    create index if not exists series_pin_order_idx on public.series (pin_order);
  end if;
end $$;

