-- Seed: initial JSF Store product
-- 1) Replace TARGET_STORE_ID with your store UUID.
-- 2) Run this in Supabase SQL Editor.

with target_store as (
  select id
  from public.stores
  where id = 'TARGET_STORE_ID'::uuid
)
insert into public.products (
  store_id,
  sku,
  name,
  title,
  product_type,
  escala,
  clothing_type,
  accessory_type,
  catchy_phrase,
  base_price,
  woo_price,
  etsy_price,
  is_active
)
select
  target_store.id,
  'JSF-STORE-001',
  'JSF Store Core Plan',
  'JSF Store Core Plan',
  'accesorios',
  null,
  null,
  'saas',
  'Centralized stock + marketplace sync',
  49.00,
  49.00,
  49.00,
  true
from target_store
where not exists (
  select 1
  from public.products p
  where p.store_id = target_store.id
    and p.sku = 'JSF-STORE-001'
);