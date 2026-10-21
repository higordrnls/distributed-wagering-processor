import { Migration } from "@mikro-orm/migrations";

export class Migration20261021000001 extends Migration {
  async up(): Promise<void> {
    this.addSql(`
      create table wallets (
        id uuid primary key,
        player_id text not null,
        currency text not null,
        balance numeric(18,2) not null,
        version integer not null default 1,
        created_at timestamptz not null,
        updated_at timestamptz not null,
        constraint wallets_player_currency_unique unique (player_id, currency),
        constraint wallets_balance_non_negative check (balance >= 0),
        constraint wallets_version_positive check (version >= 1),
        constraint wallets_currency_format check (currency ~ '^[A-Z]{3}$')
      )`);

    this.addSql(`
      create table wager_transactions (
        id uuid primary key,
        provider_id text not null,
        external_transaction_id text not null,
        idempotency_key text not null,
        payload_hash text not null,
        wallet_id uuid not null references wallets (id),
        player_id text not null,
        round_id text not null,
        game_id text not null,
        kind text not null,
        amount numeric(18,2) not null,
        currency text not null,
        reference_external_transaction_id text,
        status text not null,
        reference_transaction_id uuid references wager_transactions (id),
        failure_code text,
        reference_attempts integer not null default 0,
        next_reference_attempt_at timestamptz,
        created_at timestamptz not null,
        processed_at timestamptz,
        constraint wager_tx_provider_external_unique unique (provider_id, external_transaction_id),
        constraint wager_tx_provider_idempotency_unique unique (provider_id, idempotency_key),
        constraint wager_tx_kind_valid check (kind in ('OPENING','BET','WIN','LOSS','REFUND','ROLLBACK')),
        constraint wager_tx_status_valid check (status in ('PENDING','PENDING_REFERENCE','PROCESSED','REJECTED','FAILED')),
        constraint wager_tx_currency_format check (currency ~ '^[A-Z]{3}$'),
        constraint wager_tx_amount_valid check (amount >= 0 and (amount > 0 or kind = 'LOSS')),
        constraint wager_tx_reference_required check (kind not in ('REFUND','ROLLBACK') or reference_external_transaction_id is not null),
        constraint wager_tx_failure_code_consistent check ((status in ('REJECTED','FAILED')) = (failure_code is not null)),
        constraint wager_tx_processed_at_consistent check ((status = 'PROCESSED') = (processed_at is not null))
      )`);

    this.addSql(`create unique index wager_tx_one_reversal_per_reference
      on wager_transactions (reference_transaction_id)
      where status = 'PROCESSED' and kind in ('REFUND','ROLLBACK')`);
    this.addSql(`create index wager_tx_pending_reference_due
      on wager_transactions (next_reference_attempt_at) where status = 'PENDING_REFERENCE'`);
    this.addSql(`create index wager_tx_wallet on wager_transactions (wallet_id, created_at)`);

    this.addSql(`
      create function wager_transactions_guard() returns trigger as $$
      begin
        if tg_op = 'DELETE' then
          raise exception 'wager_transactions cannot be deleted';
        end if;
        if old.status in ('PROCESSED','REJECTED','FAILED') then
          raise exception 'wager_transactions in terminal status % cannot be modified', old.status;
        end if;
        return new;
      end;
      $$ language plpgsql`);
    this.addSql(`create trigger wager_transactions_guard_trigger
      before update or delete on wager_transactions
      for each row execute function wager_transactions_guard()`);

    this.addSql(`
      create table wallet_ledger_entries (
        seq bigint generated always as identity,
        id uuid primary key,
        wallet_id uuid not null references wallets (id),
        transaction_id uuid not null references wager_transactions (id),
        direction text not null,
        amount numeric(18,2) not null,
        currency text not null,
        balance_before numeric(18,2) not null,
        balance_after numeric(18,2) not null,
        created_at timestamptz not null,
        constraint ledger_wallet_transaction_unique unique (wallet_id, transaction_id),
        constraint ledger_direction_valid check (direction in ('DEBIT','CREDIT')),
        constraint ledger_amount_positive check (amount > 0),
        constraint ledger_balances_non_negative check (balance_before >= 0 and balance_after >= 0),
        constraint ledger_arithmetic check (
          (direction = 'CREDIT' and balance_before + amount = balance_after) or
          (direction = 'DEBIT' and balance_before - amount = balance_after)
        ),
        constraint ledger_currency_format check (currency ~ '^[A-Z]{3}$')
      )`);
    this.addSql(`create index ledger_wallet_seq on wallet_ledger_entries (wallet_id, seq)`);

    this.addSql(`
      create function wallet_ledger_entries_immutable() returns trigger as $$
      begin
        raise exception 'wallet_ledger_entries are immutable';
      end;
      $$ language plpgsql`);
    this.addSql(`create trigger wallet_ledger_entries_immutable_trigger
      before update or delete on wallet_ledger_entries
      for each row execute function wallet_ledger_entries_immutable()`);

    this.addSql(`
      create table inbox_messages (
        consumer_name text not null,
        message_id text not null,
        payload_hash text not null,
        received_at timestamptz not null,
        processed_at timestamptz,
        primary key (consumer_name, message_id)
      )`);

    this.addSql(`
      create table outbox_messages (
        id uuid primary key,
        aggregate_id text not null,
        event_type text not null,
        payload jsonb not null,
        occurred_at timestamptz not null,
        attempts integer not null default 0,
        next_attempt_at timestamptz,
        published_at timestamptz,
        constraint outbox_attempts_non_negative check (attempts >= 0)
      )`);
    this.addSql(`create index outbox_pending on outbox_messages (occurred_at) where published_at is null`);
  }

  async down(): Promise<void> {
    this.addSql("drop table if exists outbox_messages");
    this.addSql("drop table if exists inbox_messages");
    this.addSql("drop table if exists wallet_ledger_entries");
    this.addSql("drop function if exists wallet_ledger_entries_immutable()");
    this.addSql("drop table if exists wager_transactions");
    this.addSql("drop function if exists wager_transactions_guard()");
    this.addSql("drop table if exists wallets");
  }
}
