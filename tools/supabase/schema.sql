-- Air Arena BaaS optional schema (Supabase SQL editor)
-- Private rooms MVP can run on Realtime Broadcast + Presence alone.
-- These tables support TTL listing, reconnect audit, and queue durability (B2/B3).

create extension if not exists "pgcrypto";

create table if not exists public.aa_rooms (
  code text primary key,
  host_uid uuid,
  guest_uid uuid,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '45 minutes'),
  protocol text not null default 'airarena-wego-v1',
  meta jsonb not null default '{}'::jsonb
);

create index if not exists aa_rooms_expires_at_idx on public.aa_rooms (expires_at);

create table if not exists public.aa_queue (
  id uuid primary key default gen_random_uuid(),
  mode text not null default '1v1',
  player_uid uuid not null,
  seat_token text,
  created_at timestamptz not null default now(),
  unique (mode, player_uid)
);

alter table public.aa_rooms enable row level security;
alter table public.aa_queue enable row level security;

-- MVP: authenticated (incl. anonymous) users can read/write their queue rows and rooms.
-- Tighten for production.

drop policy if exists aa_rooms_select on public.aa_rooms;
create policy aa_rooms_select on public.aa_rooms
  for select to authenticated using (true);

drop policy if exists aa_rooms_insert on public.aa_rooms;
create policy aa_rooms_insert on public.aa_rooms
  for insert to authenticated with check (true);

drop policy if exists aa_rooms_update on public.aa_rooms;
create policy aa_rooms_update on public.aa_rooms
  for update to authenticated using (true);

drop policy if exists aa_queue_all on public.aa_queue;
create policy aa_queue_all on public.aa_queue
  for all to authenticated using (true) with check (true);

-- Enable Realtime for optional table-driven flows
-- Dashboard → Database → Replication → add aa_rooms / aa_queue if used.
