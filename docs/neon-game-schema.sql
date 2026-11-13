-- Banco EXCLUSIVO do Tigrinho fictício. Execute no SQL Editor do Neon.
CREATE TABLE IF NOT EXISTS game_players (
  id uuid PRIMARY KEY,
  token_hash text NOT NULL UNIQUE,
  balance integer NOT NULL DEFAULT 1000 CHECK (balance >= 0),
  spins integer NOT NULL DEFAULT 0 CHECK (spins >= 0),
  wins integer NOT NULL DEFAULT 0 CHECK (wins >= 0),
  best integer NOT NULL DEFAULT 0 CHECK (best >= 0),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS game_rounds (
  id uuid PRIMARY KEY,
  player_id uuid NOT NULL REFERENCES game_players(id),
  bet integer NOT NULL CHECK (bet IN (10,25,50,100)),
  prize integer NOT NULL CHECK (prize >= 0),
  symbols text[] NOT NULL,
  balance_after integer NOT NULL CHECK (balance_after >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (player_id,id)
);
CREATE INDEX IF NOT EXISTS game_rounds_player_created_idx ON game_rounds (player_id,created_at DESC);
CREATE OR REPLACE FUNCTION game_spin(p_token_hash text,p_request_id uuid,p_bet integer)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  p game_players%ROWTYPE;
  existing game_rounds%ROWTYPE;
  syms text[];
  icons text[] := ARRAY['🐯','⭐','🍀','🍊','🍒','💎'];
  multiplier integer;
  payout integer;
  updated_balance integer;
BEGIN
  IF p_bet NOT IN (10,25,50,100) OR p_bet IS NULL THEN
    RAISE EXCEPTION 'INVALID_BET';
  END IF;
  SELECT * INTO p FROM game_players WHERE token_hash=p_token_hash FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'SESSION_NOT_FOUND'; END IF;
  SELECT * INTO existing FROM game_rounds WHERE id=p_request_id AND player_id=p.id;
  IF FOUND THEN
    IF existing.bet <> p_bet THEN RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT'; END IF;
    RETURN jsonb_build_object('symbols',existing.symbols,'prize',existing.prize,
      'balance',existing.balance_after,'spins',p.spins,'wins',p.wins,'best',p.best,'replay',true);
  END IF;
  IF p.balance < p_bet THEN RAISE EXCEPTION 'INSUFFICIENT_BALANCE'; END IF;
  SELECT array_agg(icons[1+floor(random()*6)::int] ORDER BY n)
    INTO syms FROM generate_series(1,3) AS n;
  multiplier := CASE
    WHEN syms[1]=syms[2] AND syms[2]=syms[3] THEN
      CASE syms[1] WHEN '🐯' THEN 10 WHEN '⭐' THEN 6 WHEN '🍀' THEN 4 ELSE 3 END
    WHEN (SELECT count(*) FROM unnest(syms) s WHERE s='🐯')=2 THEN 2
    ELSE 0 END;
  payout := p_bet * multiplier;
  UPDATE game_players SET balance=balance-p_bet+payout,spins=spins+1,
    wins=wins+(CASE WHEN payout>0 THEN 1 ELSE 0 END),best=greatest(best,payout)
    WHERE id=p.id RETURNING balance INTO updated_balance;
  INSERT INTO game_rounds(id,player_id,bet,prize,symbols,balance_after)
    VALUES(p_request_id,p.id,p_bet,payout,syms,updated_balance);
  RETURN jsonb_build_object('symbols',syms,'prize',payout,'balance',updated_balance,
    'spins',p.spins+1,'wins',p.wins+(CASE WHEN payout>0 THEN 1 ELSE 0 END),
    'best',greatest(p.best,payout),'replay',false);
END $$;
