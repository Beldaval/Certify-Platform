-- ============================================================================
-- Certificate Generation & Delivery Platform — Supabase schema (Phase 1)
-- Run this once in the Supabase SQL editor for your project.
-- Safe to re-run: uses IF NOT EXISTS / CREATE OR REPLACE throughout.
-- ============================================================================

create extension if not exists "pgcrypto";

-- ----------------------------------------------------------------------------
-- 1. USERS (profile row that mirrors auth.users; admin flag lives here)
-- ----------------------------------------------------------------------------
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  full_name text,
  organization_name text,
  is_admin boolean not null default false,
  created_at timestamptz not null default now()
);

-- Auto-create a profile + wallet whenever a new auth user signs up
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, email, full_name)
  values (new.id, new.email, coalesce(new.raw_user_meta_data->>'full_name', ''));

  insert into public.wallets (user_id, trial_tokens_remaining, purchased_tokens)
  values (new.id, 500, 0);

  insert into public.token_transactions (user_id, type, token_amount, balance_after, note)
  values (new.id, 'trial_grant', 500, 500, 'Welcome grant: 500 trial tokens (10 free certificates)');

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- ----------------------------------------------------------------------------
-- 2. WALLET  (FR-4, FR-5, FR-6, SEC-9 — atomic balance)
-- ----------------------------------------------------------------------------
create table if not exists public.wallets (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  trial_tokens_remaining integer not null default 0 check (trial_tokens_remaining >= 0),
  purchased_tokens integer not null default 0 check (purchased_tokens >= 0),
  updated_at timestamptz not null default now()
);

create table if not exists public.token_transactions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  type text not null check (type in ('trial_grant','purchase','deduction','refund','manual_adjustment')),
  token_amount integer not null, -- positive = credit, negative = debit
  related_batch_id uuid,
  related_payment_id uuid,
  admin_id uuid references public.profiles(id),
  note text,
  balance_after integer not null,
  created_at timestamptz not null default now()
);

-- ----------------------------------------------------------------------------
-- 3. PAYMENTS  (FR-5)
-- ----------------------------------------------------------------------------
create table if not exists public.payments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  paystack_reference text not null unique,
  amount_kobo bigint not null,
  tokens_credited integer,
  status text not null default 'pending' check (status in ('pending','success','failed')),
  created_at timestamptz not null default now()
);

-- ----------------------------------------------------------------------------
-- 4. TEMPLATES  (FR-2)
-- ----------------------------------------------------------------------------
create table if not exists public.templates (
  id text primary key, -- matches templates.json "id"
  name text not null,
  svg_file text not null,
  canvas_width integer not null,
  canvas_height integer not null,
  fields jsonb not null,
  active boolean not null default true
);

-- ----------------------------------------------------------------------------
-- 5. BATCHES + CERTIFICATES  (FR-3, FR-6, FR-7, FR-8)
-- ----------------------------------------------------------------------------
create table if not exists public.batches (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  template_id text not null references public.templates(id),
  status text not null default 'pending' check (status in ('pending','generating','completed','failed')),
  token_cost integer not null,
  same_email boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists public.certificates (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references public.batches(id) on delete cascade,
  template_id text not null references public.templates(id),
  certificate_number text not null unique,
  -- Every template field for this certificate: text strings, image fields as
  -- data: URIs, block-toggle booleans. Keyed by the template's own field ids.
  field_values jsonb not null default '{}'::jsonb,
  recipient_name text not null,
  recipient_email text,
  program_title text not null,
  issuing_organization text not null,
  issue_date date not null default current_date,
  generation_status text not null default 'pending' check (generation_status in ('pending','generated','failed')),
  delivery_status text not null default 'pending' check (delivery_status in ('pending','sent','failed','skipped')),
  pdf_path text,   -- storage object path (private bucket)
  jpeg_path text,  -- storage object path (private bucket)
  created_at timestamptz not null default now()
);

create index if not exists idx_certificates_batch on public.certificates(batch_id);
create index if not exists idx_certificates_number on public.certificates(certificate_number);

-- Auto-assign a random certificate number on insert if the caller didn't supply one
create or replace function public.set_certificate_number()
returns trigger
language plpgsql
as $$
begin
  if new.certificate_number is null or new.certificate_number = '' then
    new.certificate_number := public.generate_certificate_number();
  end if;
  return new;
end;
$$;

drop trigger if exists trg_set_certificate_number on public.certificates;
create trigger trg_set_certificate_number
  before insert on public.certificates
  for each row execute procedure public.set_certificate_number();

-- Random, non-sequential certificate number generator (SEC-6 / FR-6.5)
create or replace function public.generate_certificate_number()
returns text
language plpgsql
as $$
declare
  candidate text;
  exists_already boolean;
begin
  loop
    candidate := 'CERT-' || upper(substr(encode(gen_random_bytes(6), 'hex'), 1, 10));
    select exists(select 1 from public.certificates where certificate_number = candidate) into exists_already;
    exit when not exists_already;
  end loop;
  return candidate;
end;
$$;

-- ----------------------------------------------------------------------------
-- 6. ATOMIC WALLET OPERATIONS (SEC-9 / FR-6.3 / FR-5.5-5.7 / FR-6.9)
-- ----------------------------------------------------------------------------

-- Deduct tokens for a batch atomically. Trial tokens are spent before purchased tokens.
-- Raises an exception (and rolls back) if the balance is insufficient.
create or replace function public.deduct_tokens_for_batch(p_user_id uuid, p_amount integer, p_batch_id uuid)
returns integer
language plpgsql
security definer set search_path = public
as $$
declare
  v_trial integer;
  v_purchased integer;
  v_from_trial integer;
  v_from_purchased integer;
  v_new_balance integer;
begin
  select trial_tokens_remaining, purchased_tokens
    into v_trial, v_purchased
    from public.wallets
   where user_id = p_user_id
   for update; -- row lock prevents concurrent overspend

  if v_trial + v_purchased < p_amount then
    raise exception 'INSUFFICIENT_TOKENS';
  end if;

  v_from_trial := least(v_trial, p_amount);
  v_from_purchased := p_amount - v_from_trial;

  update public.wallets
     set trial_tokens_remaining = trial_tokens_remaining - v_from_trial,
         purchased_tokens = purchased_tokens - v_from_purchased,
         updated_at = now()
   where user_id = p_user_id;

  select trial_tokens_remaining + purchased_tokens into v_new_balance
    from public.wallets where user_id = p_user_id;

  insert into public.token_transactions (user_id, type, token_amount, related_batch_id, balance_after, note)
  values (p_user_id, 'deduction', -p_amount, p_batch_id, v_new_balance, 'Batch generation');

  return v_new_balance;
end;
$$;

-- Refund a single certificate's token (FR-6.9) — refunded to purchased pool
create or replace function public.refund_token(p_user_id uuid, p_batch_id uuid, p_reason text)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  v_new_balance integer;
begin
  update public.wallets
     set purchased_tokens = purchased_tokens + 1,
         updated_at = now()
   where user_id = p_user_id;

  select trial_tokens_remaining + purchased_tokens into v_new_balance
    from public.wallets where user_id = p_user_id;

  insert into public.token_transactions (user_id, type, token_amount, related_batch_id, balance_after, note)
  values (p_user_id, 'refund', 1, p_batch_id, v_new_balance, coalesce(p_reason, 'Generation failed'));
end;
$$;

-- Credit tokens after a Paystack payment is independently verified (FR-5.5, FR-5.7)
-- Idempotent: if the reference was already credited, this is a no-op.
create or replace function public.credit_tokens_for_payment(
  p_user_id uuid, p_reference text, p_amount_kobo bigint, p_tokens integer
)
returns integer
language plpgsql
security definer set search_path = public
as $$
declare
  v_existing text;
  v_new_balance integer;
begin
  select paystack_reference into v_existing
    from public.payments where paystack_reference = p_reference and status = 'success';

  if v_existing is not null then
    -- already credited once, ignore replay/duplicate webhook
    select trial_tokens_remaining + purchased_tokens into v_new_balance
      from public.wallets where user_id = p_user_id;
    return v_new_balance;
  end if;

  insert into public.payments (user_id, paystack_reference, amount_kobo, tokens_credited, status)
  values (p_user_id, p_reference, p_amount_kobo, p_tokens, 'success')
  on conflict (paystack_reference) do update set status = 'success', tokens_credited = p_tokens;

  update public.wallets
     set purchased_tokens = purchased_tokens + p_tokens,
         updated_at = now()
   where user_id = p_user_id;

  select trial_tokens_remaining + purchased_tokens into v_new_balance
    from public.wallets where user_id = p_user_id;

  insert into public.token_transactions (user_id, type, token_amount, related_payment_id, balance_after, note)
  select p_user_id, 'purchase', p_tokens, id, v_new_balance, 'Paystack top-up ' || p_reference
    from public.payments where paystack_reference = p_reference;

  return v_new_balance;
end;
$$;

-- Manual admin credit (FR-9.4, FR-9.5, SEC-10) — only ever called from the
-- admin-manual-credit function, which itself checks profiles.is_admin first.
create or replace function public.manual_credit_tokens(
  p_user_id uuid, p_amount integer, p_admin_id uuid, p_reason text
)
returns integer
language plpgsql
security definer set search_path = public
as $$
declare
  v_new_balance integer;
begin
  update public.wallets
     set purchased_tokens = purchased_tokens + p_amount,
         updated_at = now()
   where user_id = p_user_id;

  select trial_tokens_remaining + purchased_tokens into v_new_balance
    from public.wallets where user_id = p_user_id;

  insert into public.token_transactions (user_id, type, token_amount, admin_id, balance_after, note)
  values (p_user_id, 'manual_adjustment', p_amount, p_admin_id, v_new_balance, p_reason);

  return v_new_balance;
end;
$$;

-- ----------------------------------------------------------------------------
-- 7. ROW LEVEL SECURITY  (SEC-4, SEC-5, SEC-11)
-- ----------------------------------------------------------------------------
alter table public.profiles enable row level security;
alter table public.wallets enable row level security;
alter table public.token_transactions enable row level security;
alter table public.payments enable row level security;
alter table public.batches enable row level security;
alter table public.certificates enable row level security;
alter table public.templates enable row level security;

-- profiles: a user can read/update only their own row
drop policy if exists "own profile" on public.profiles;
create policy "own profile" on public.profiles
  for select using (auth.uid() = id);
drop policy if exists "own profile update" on public.profiles;
create policy "own profile update" on public.profiles
  for update using (auth.uid() = id);

-- wallets: read-only, own row
drop policy if exists "own wallet" on public.wallets;
create policy "own wallet" on public.wallets
  for select using (auth.uid() = user_id);

-- token_transactions: own rows only
drop policy if exists "own token transactions" on public.token_transactions;
create policy "own token transactions" on public.token_transactions
  for select using (auth.uid() = user_id);

-- payments: own rows only
drop policy if exists "own payments" on public.payments;
create policy "own payments" on public.payments
  for select using (auth.uid() = user_id);

-- batches: own rows only
drop policy if exists "own batches" on public.batches;
create policy "own batches" on public.batches
  for select using (auth.uid() = user_id);
drop policy if exists "insert own batches" on public.batches;
create policy "insert own batches" on public.batches
  for insert with check (auth.uid() = user_id);

-- certificates: readable only via the parent batch's owner
drop policy if exists "own certificates" on public.certificates;
create policy "own certificates" on public.certificates
  for select using (
    exists (select 1 from public.batches b where b.id = batch_id and b.user_id = auth.uid())
  );

-- templates: any authenticated user can read active templates
drop policy if exists "read active templates" on public.templates;
create policy "read active templates" on public.templates
  for select using (active = true);

-- NOTE: There is intentionally NO public/anon SELECT policy on certificates,
-- payments, wallets, token_transactions, or profiles. The public verification
-- lookup (FR-10) and the admin endpoints (FR-9) both run through Netlify
-- Functions using the Supabase SERVICE ROLE key, which bypasses RLS on the
-- server only, and each function hand-picks exactly which columns it returns
-- (see netlify/functions/verify-certificate.js). This is what makes SEC-5
-- structural rather than UI-level: the anon/public API key on its own cannot
-- read these tables at all.

-- ----------------------------------------------------------------------------
-- 8. Seed the 8 launch templates
-- Run scripts/seed-templates.js after deploy (reads assets/templates.json)
-- instead of hardcoding the field JSON here, so template edits stay in one file.
-- ----------------------------------------------------------------------------
