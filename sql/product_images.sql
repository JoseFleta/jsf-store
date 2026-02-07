create table if not exists public.product_images (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id) on delete cascade,
  product_id uuid not null references public.products(id) on delete cascade,
  storage_path text not null,
  sort_order integer not null default 0,
  is_primary boolean not null default false,
  created_at timestamptz not null default now(),
  unique (product_id, storage_path)
);

create index if not exists idx_product_images_store_id on public.product_images(store_id);
create index if not exists idx_product_images_product_id on public.product_images(product_id);

alter table public.product_images enable row level security;

drop policy if exists "product_images_select" on public.product_images;
create policy "product_images_select"
on public.product_images
for select
using (
  exists (
    select 1
    from public.store_memberships sm
    where sm.store_id = product_images.store_id
      and sm.user_id = auth.uid()
  )
);

drop policy if exists "product_images_insert" on public.product_images;
create policy "product_images_insert"
on public.product_images
for insert
with check (
  exists (
    select 1
    from public.store_memberships sm
    where sm.store_id = product_images.store_id
      and sm.user_id = auth.uid()
  )
);

drop policy if exists "product_images_update" on public.product_images;
create policy "product_images_update"
on public.product_images
for update
using (
  exists (
    select 1
    from public.store_memberships sm
    where sm.store_id = product_images.store_id
      and sm.user_id = auth.uid()
  )
)
with check (
  exists (
    select 1
    from public.store_memberships sm
    where sm.store_id = product_images.store_id
      and sm.user_id = auth.uid()
  )
);

drop policy if exists "product_images_delete" on public.product_images;
create policy "product_images_delete"
on public.product_images
for delete
using (
  exists (
    select 1
    from public.store_memberships sm
    where sm.store_id = product_images.store_id
      and sm.user_id = auth.uid()
  )
);

insert into storage.buckets (id, name, public)
values ('product-images', 'product-images', true)
on conflict (id) do nothing;

drop policy if exists "product_images_storage_select" on storage.objects;
create policy "product_images_storage_select"
on storage.objects
for select
using (
  bucket_id = 'product-images'
  and exists (
    select 1
    from public.store_memberships sm
    where sm.user_id = auth.uid()
      and sm.store_id::text = split_part(name, '/', 1)
  )
);

drop policy if exists "product_images_storage_insert" on storage.objects;
create policy "product_images_storage_insert"
on storage.objects
for insert
with check (
  bucket_id = 'product-images'
  and exists (
    select 1
    from public.store_memberships sm
    where sm.user_id = auth.uid()
      and sm.store_id::text = split_part(name, '/', 1)
  )
);

drop policy if exists "product_images_storage_update" on storage.objects;
create policy "product_images_storage_update"
on storage.objects
for update
using (
  bucket_id = 'product-images'
  and exists (
    select 1
    from public.store_memberships sm
    where sm.user_id = auth.uid()
      and sm.store_id::text = split_part(name, '/', 1)
  )
)
with check (
  bucket_id = 'product-images'
  and exists (
    select 1
    from public.store_memberships sm
    where sm.user_id = auth.uid()
      and sm.store_id::text = split_part(name, '/', 1)
  )
);

drop policy if exists "product_images_storage_delete" on storage.objects;
create policy "product_images_storage_delete"
on storage.objects
for delete
using (
  bucket_id = 'product-images'
  and exists (
    select 1
    from public.store_memberships sm
    where sm.user_id = auth.uid()
      and sm.store_id::text = split_part(name, '/', 1)
  )
);
