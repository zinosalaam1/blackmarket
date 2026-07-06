-- ============================================================================
-- THE BLACK MARKET — add contracts for the 9 new items added in 0007
-- _contract_template() was never updated, so medicine, oil_drums,
-- data_drives, rare_earth, weapons_cache, prototype_ai, dark_matter,
-- stolen_art, and neural_implant never appeared on the contract board.
-- ============================================================================

create or replace function _contract_template()
returns table(author text, demand text, reward numeric, risk text, is_illegal boolean, item_id text, qty_required int, ttl_seconds int)
language sql immutable as $$
  values
    -- original 10
    ('The_Broker',  'Deliver 1× Quantum Chip',                            50000, 'HIGH',    false, 'quantum_chip',   1, 900),
    ('CIPHER_X',    'Deliver 3× Ancient Coins',                           12000, 'MED',     false, 'ancient_coins',  3, 600),
    ('Madame_X',    'Deliver 2× Gold',                                     8000, 'LOW',     false, 'gold',           2, 1200),
    ('ShadowDealer','Deliver 1× Gov. Secrets — no questions asked',        25000, 'EXTREME', true,  'gov_secrets',    1, 500),
    ('NightOwl',    'Deliver 2× Bio Sample',                              18000, 'EXTREME', true,  'bio_sample',     2, 500),
    ('The_Cartel',  'Deliver 1× Red Diamond',                             30000, 'HIGH',    false, 'red_diamond',    1, 700),
    ('Anon_Buyer',  'Deliver 5× Batteries',                                4000, 'LOW',     false, 'batteries',      5, 900),
    ('Mr_Fixit',    'Deliver 2× Crypto Keys',                             15000, 'MED',     false, 'crypto_keys',    2, 800),
    ('Q',           'Deliver 4× Fuel Cells',                               6000, 'LOW',     false, 'fuel',           4, 1000),
    ('The_Archivist','Deliver 1× Lost Document',                           9000, 'MED',     false, 'lost_docs',      1, 800),
    -- 9 new items from 0007
    ('MedSupply_X', 'Deliver 5× Medicine — field hospital needs it now',   3500, 'LOW',     false, 'medicine',       5, 1000),
    ('Refinery_K',  'Deliver 6× Oil Drums — no questions on origin',       3200, 'LOW',     false, 'oil_drums',      6, 900),
    ('Phantom_Data','Deliver 2× Data Drives — contents classified',        16000, 'MED',     false, 'data_drives',    2, 700),
    ('The_Miner',   'Deliver 1× Rare Earth — buyer outbids the market',    12000, 'MED',     false, 'rare_earth',     1, 800),
    ('Iron_Ghost',  'Deliver 1× Weapons Cache — discretion required',      28000, 'EXTREME', true,  'weapons_cache',  1, 400),
    ('NEXUS_Corp',  'Deliver 1× Prototype AI — corporate acquisition',     55000, 'HIGH',    false, 'prototype_ai',   1, 600),
    ('Void_Labs',   'Deliver 1× Dark Matter — extremely time-sensitive',   65000, 'HIGH',    false, 'dark_matter',    1, 500),
    ('The_Fence',   'Deliver 1× Stolen Art — buyer asks no questions',     45000, 'EXTREME', true,  'stolen_art',     1, 400),
    ('BioCorp',     'Deliver 1× Neural Implant — premium paid for speed',  48000, 'HIGH',    false, 'neural_implant', 1, 550);
$$;
