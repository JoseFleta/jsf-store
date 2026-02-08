create table if not exists public.product_marketplace_fingerprints (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id) on delete cascade,
  product_id uuid not null references public.products(id) on delete cascade,
  sku text not null,
  local_price_fingerprint text not null default '',
  local_media_fingerprint text not null default '',
  local_payload_fingerprint text not null default '',
  local_snapshot_json jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  unique (store_id, product_id)
);

create index if not exists idx_product_marketplace_fingerprints_store_id on public.product_marketplace_fingerprints(store_id);
create index if not exists idx_product_marketplace_fingerprints_sku on public.product_marketplace_fingerprints(sku);

create table if not exists public.marketplace_product_snapshots (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id) on delete cascade,
  product_id uuid not null references public.products(id) on delete cascade,
  sku text not null,
  channel text not null check (channel in ('woocommerce', 'etsy', 'amazon', 'shopify')),
  external_id text null,
  title text null,
  status text null,
  currency text null,
  price numeric(12, 2) null,
  stock_qty integer null,
  remote_payload_fingerprint text null,
  last_local_payload_fingerprint text null,
  sync_state text not null default 'unknown' check (sync_state in ('published', 'needs_publish', 'unknown', 'error')),
  last_error text null,
  last_published_at timestamptz null,
  updated_at timestamptz not null default now(),
  raw_json jsonb not null default '{}'::jsonb,
  unique (store_id, product_id, channel)
);

create unique index if not exists idx_marketplace_product_snapshots_external
on public.marketplace_product_snapshots(store_id, channel, external_id)
where external_id is not null;

create index if not exists idx_marketplace_product_snapshots_store_id on public.marketplace_product_snapshots(store_id);
create index if not exists idx_marketplace_product_snapshots_product_id on public.marketplace_product_snapshots(product_id);
create index if not exists idx_marketplace_product_snapshots_channel on public.marketplace_product_snapshots(channel);
create index if not exists idx_marketplace_product_snapshots_sync_state on public.marketplace_product_snapshots(sync_state);

create table if not exists public.marketplace_product_image_snapshots (
  id uuid primary key default gen_random_uuid(),
  snapshot_id uuid not null references public.marketplace_product_snapshots(id) on delete cascade,
  store_id uuid not null references public.stores(id) on delete cascade,
  product_id uuid not null references public.products(id) on delete cascade,
  channel text not null check (channel in ('woocommerce', 'etsy', 'amazon', 'shopify')),
  external_image_id text null,
  image_url text not null,
  sort_order integer not null default 0,
  is_primary boolean not null default false,
  image_fingerprint text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (snapshot_id, image_url)
);

create index if not exists idx_marketplace_product_image_snapshots_store_id on public.marketplace_product_image_snapshots(store_id);
create index if not exists idx_marketplace_product_image_snapshots_product_id on public.marketplace_product_image_snapshots(product_id);
create index if not exists idx_marketplace_product_image_snapshots_snapshot_id on public.marketplace_product_image_snapshots(snapshot_id);

create table if not exists public.marketplace_sync_runs (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id) on delete cascade,
  channel text null check (channel in ('woocommerce', 'etsy', 'amazon', 'shopify', 'all')),
  scope text not null default 'manual',
  status text not null default 'running' check (status in ('running', 'success', 'partial', 'failed')),
  triggered_by uuid null references auth.users(id) on delete set null,
  requested_product_ids uuid[] null,
  processed_count integer not null default 0,
  warning_count integer not null default 0,
  error_count integer not null default 0,
  summary text null,
  details_json jsonb not null default '{}'::jsonb,
  started_at timestamptz not null default now(),
  finished_at timestamptz null
);

create index if not exists idx_marketplace_sync_runs_store_id on public.marketplace_sync_runs(store_id);
create index if not exists idx_marketplace_sync_runs_started_at on public.marketplace_sync_runs(started_at desc);

create table if not exists public.marketplace_sync_warnings (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id) on delete cascade,
  product_id uuid not null references public.products(id) on delete cascade,
  sku text not null,
  channel text not null check (channel in ('woocommerce', 'etsy', 'amazon', 'shopify')),
  warning_type text not null check (warning_type in ('price_mismatch', 'photo_mismatch', 'status_mismatch', 'stock_mismatch', 'not_published', 'missing_mapping')),
  severity text not null default 'warning' check (severity in ('info', 'warning', 'critical')),
  message text null,
  local_value jsonb not null default '{}'::jsonb,
  remote_value jsonb not null default '{}'::jsonb,
  is_resolved boolean not null default false,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  resolved_at timestamptz null,
  sync_run_id uuid null references public.marketplace_sync_runs(id) on delete set null
);

create unique index if not exists idx_marketplace_sync_warnings_open_unique
on public.marketplace_sync_warnings(store_id, product_id, channel, warning_type)
where is_resolved = false;

create index if not exists idx_marketplace_sync_warnings_store_id on public.marketplace_sync_warnings(store_id);
create index if not exists idx_marketplace_sync_warnings_resolved on public.marketplace_sync_warnings(is_resolved);

alter table public.product_marketplace_fingerprints enable row level security;
alter table public.marketplace_product_snapshots enable row level security;
alter table public.marketplace_product_image_snapshots enable row level security;
alter table public.marketplace_sync_runs enable row level security;
alter table public.marketplace_sync_warnings enable row level security;

drop policy if exists "product_marketplace_fingerprints_select" on public.product_marketplace_fingerprints;
create policy "product_marketplace_fingerprints_select"
on public.product_marketplace_fingerprints
for select
using (
  exists (
    select 1
    from public.store_memberships sm
    where sm.store_id = product_marketplace_fingerprints.store_id
      and sm.user_id = auth.uid()
  )
);

drop policy if exists "product_marketplace_fingerprints_insert" on public.product_marketplace_fingerprints;
create policy "product_marketplace_fingerprints_insert"
on public.product_marketplace_fingerprints
for insert
with check (
  exists (
    select 1
    from public.store_memberships sm
    where sm.store_id = product_marketplace_fingerprints.store_id
      and sm.user_id = auth.uid()
  )
);

drop policy if exists "product_marketplace_fingerprints_update" on public.product_marketplace_fingerprints;
create policy "product_marketplace_fingerprints_update"
on public.product_marketplace_fingerprints
for update
using (
  exists (
    select 1
    from public.store_memberships sm
    where sm.store_id = product_marketplace_fingerprints.store_id
      and sm.user_id = auth.uid()
  )
)
with check (
  exists (
    select 1
    from public.store_memberships sm
    where sm.store_id = product_marketplace_fingerprints.store_id
      and sm.user_id = auth.uid()
  )
);

drop policy if exists "product_marketplace_fingerprints_delete" on public.product_marketplace_fingerprints;
create policy "product_marketplace_fingerprints_delete"
on public.product_marketplace_fingerprints
for delete
using (
  exists (
    select 1
    from public.store_memberships sm
    where sm.store_id = product_marketplace_fingerprints.store_id
      and sm.user_id = auth.uid()
  )
);

drop policy if exists "marketplace_product_snapshots_select" on public.marketplace_product_snapshots;
create policy "marketplace_product_snapshots_select"
on public.marketplace_product_snapshots
for select
using (
  exists (
    select 1
    from public.store_memberships sm
    where sm.store_id = marketplace_product_snapshots.store_id
      and sm.user_id = auth.uid()
  )
);

drop policy if exists "marketplace_product_snapshots_insert" on public.marketplace_product_snapshots;
create policy "marketplace_product_snapshots_insert"
on public.marketplace_product_snapshots
for insert
with check (
  exists (
    select 1
    from public.store_memberships sm
    where sm.store_id = marketplace_product_snapshots.store_id
      and sm.user_id = auth.uid()
  )
);

drop policy if exists "marketplace_product_snapshots_update" on public.marketplace_product_snapshots;
create policy "marketplace_product_snapshots_update"
on public.marketplace_product_snapshots
for update
using (
  exists (
    select 1
    from public.store_memberships sm
    where sm.store_id = marketplace_product_snapshots.store_id
      and sm.user_id = auth.uid()
  )
)
with check (
  exists (
    select 1
    from public.store_memberships sm
    where sm.store_id = marketplace_product_snapshots.store_id
      and sm.user_id = auth.uid()
  )
);

drop policy if exists "marketplace_product_snapshots_delete" on public.marketplace_product_snapshots;
create policy "marketplace_product_snapshots_delete"
on public.marketplace_product_snapshots
for delete
using (
  exists (
    select 1
    from public.store_memberships sm
    where sm.store_id = marketplace_product_snapshots.store_id
      and sm.user_id = auth.uid()
  )
);

drop policy if exists "marketplace_product_image_snapshots_select" on public.marketplace_product_image_snapshots;
create policy "marketplace_product_image_snapshots_select"
on public.marketplace_product_image_snapshots
for select
using (
  exists (
    select 1
    from public.store_memberships sm
    where sm.store_id = marketplace_product_image_snapshots.store_id
      and sm.user_id = auth.uid()
  )
);

drop policy if exists "marketplace_product_image_snapshots_insert" on public.marketplace_product_image_snapshots;
create policy "marketplace_product_image_snapshots_insert"
on public.marketplace_product_image_snapshots
for insert
with check (
  exists (
    select 1
    from public.store_memberships sm
    where sm.store_id = marketplace_product_image_snapshots.store_id
      and sm.user_id = auth.uid()
  )
);

drop policy if exists "marketplace_product_image_snapshots_update" on public.marketplace_product_image_snapshots;
create policy "marketplace_product_image_snapshots_update"
on public.marketplace_product_image_snapshots
for update
using (
  exists (
    select 1
    from public.store_memberships sm
    where sm.store_id = marketplace_product_image_snapshots.store_id
      and sm.user_id = auth.uid()
  )
)
with check (
  exists (
    select 1
    from public.store_memberships sm
    where sm.store_id = marketplace_product_image_snapshots.store_id
      and sm.user_id = auth.uid()
  )
);

drop policy if exists "marketplace_product_image_snapshots_delete" on public.marketplace_product_image_snapshots;
create policy "marketplace_product_image_snapshots_delete"
on public.marketplace_product_image_snapshots
for delete
using (
  exists (
    select 1
    from public.store_memberships sm
    where sm.store_id = marketplace_product_image_snapshots.store_id
      and sm.user_id = auth.uid()
  )
);

drop policy if exists "marketplace_sync_runs_select" on public.marketplace_sync_runs;
create policy "marketplace_sync_runs_select"
on public.marketplace_sync_runs
for select
using (
  exists (
    select 1
    from public.store_memberships sm
    where sm.store_id = marketplace_sync_runs.store_id
      and sm.user_id = auth.uid()
  )
);

drop policy if exists "marketplace_sync_runs_insert" on public.marketplace_sync_runs;
create policy "marketplace_sync_runs_insert"
on public.marketplace_sync_runs
for insert
with check (
  exists (
    select 1
    from public.store_memberships sm
    where sm.store_id = marketplace_sync_runs.store_id
      and sm.user_id = auth.uid()
  )
);

drop policy if exists "marketplace_sync_runs_update" on public.marketplace_sync_runs;
create policy "marketplace_sync_runs_update"
on public.marketplace_sync_runs
for update
using (
  exists (
    select 1
    from public.store_memberships sm
    where sm.store_id = marketplace_sync_runs.store_id
      and sm.user_id = auth.uid()
  )
)
with check (
  exists (
    select 1
    from public.store_memberships sm
    where sm.store_id = marketplace_sync_runs.store_id
      and sm.user_id = auth.uid()
  )
);

drop policy if exists "marketplace_sync_warnings_select" on public.marketplace_sync_warnings;
create policy "marketplace_sync_warnings_select"
on public.marketplace_sync_warnings
for select
using (
  exists (
    select 1
    from public.store_memberships sm
    where sm.store_id = marketplace_sync_warnings.store_id
      and sm.user_id = auth.uid()
  )
);

drop policy if exists "marketplace_sync_warnings_insert" on public.marketplace_sync_warnings;
create policy "marketplace_sync_warnings_insert"
on public.marketplace_sync_warnings
for insert
with check (
  exists (
    select 1
    from public.store_memberships sm
    where sm.store_id = marketplace_sync_warnings.store_id
      and sm.user_id = auth.uid()
  )
);

drop policy if exists "marketplace_sync_warnings_update" on public.marketplace_sync_warnings;
create policy "marketplace_sync_warnings_update"
on public.marketplace_sync_warnings
for update
using (
  exists (
    select 1
    from public.store_memberships sm
    where sm.store_id = marketplace_sync_warnings.store_id
      and sm.user_id = auth.uid()
  )
)
with check (
  exists (
    select 1
    from public.store_memberships sm
    where sm.store_id = marketplace_sync_warnings.store_id
      and sm.user_id = auth.uid()
  )
);

drop policy if exists "marketplace_sync_warnings_delete" on public.marketplace_sync_warnings;
create policy "marketplace_sync_warnings_delete"
on public.marketplace_sync_warnings
for delete
using (
  exists (
    select 1
    from public.store_memberships sm
    where sm.store_id = marketplace_sync_warnings.store_id
      and sm.user_id = auth.uid()
  )
);
