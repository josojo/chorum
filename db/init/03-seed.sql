-- Demo seed data for hearme v0.
--
-- Populates yes/no questions across three scopes (worldwide / continent /
-- country), envelopes with varied disclosed predicates, and matching
-- aggregates so the UI looks alive on first boot. Questions are phrased so a
-- verified agent answers "yes" or "no"; aggregates therefore record a yes/no
-- tally per predicate bucket (see ARCHITECTURE.md §3), e.g.
--   {"region:EU": {"yes": 30, "no": 18}, "age_band:25-34": {"yes": 36, "no": 25}}
-- Idempotent: ON CONFLICT DO NOTHING / DO UPDATE throughout.
--
-- Runs as the postgres superuser during docker-entrypoint-initdb.d execution
-- (alphabetical order, after 01-schema and 02-roles), so it can write to
-- broker-owned tables (envelopes, aggregates).

BEGIN;

-- A handful of distinct asker display rows.
WITH new_askers AS (
  INSERT INTO askers (id, display_name) VALUES
    ('00000000-0000-0000-0000-000000000001', 'Maya'),
    ('00000000-0000-0000-0000-000000000002', 'Hiroshi'),
    ('00000000-0000-0000-0000-000000000003', 'Sofia'),
    ('00000000-0000-0000-0000-000000000004', 'Lukas'),
    ('00000000-0000-0000-0000-000000000005', 'Aiyana'),
    ('00000000-0000-0000-0000-000000000006', 'Olamide'),
    ('00000000-0000-0000-0000-000000000007', 'Priya'),
    ('00000000-0000-0000-0000-000000000008', 'Nikolai'),
    ('00000000-0000-0000-0000-000000000009', 'Camila'),
    ('00000000-0000-0000-0000-00000000000a', 'Yuki'),
    ('00000000-0000-0000-0000-00000000000b', 'Anders'),
    ('00000000-0000-0000-0000-00000000000c', 'Fatima')
  ON CONFLICT (id) DO NOTHING
  RETURNING id
)
SELECT 1;

-- Demo questions across scopes. All are yes/no so the breakdowns can show
-- how each cohort voted. Closes in 20-60 days so the set stays "open".
INSERT INTO questions (id, asker_id, text, topic, scope, country, continent, closes_at) VALUES
  -- Worldwide
  ('10000000-0000-0000-0000-000000000001',
    '00000000-0000-0000-0000-000000000001',
    'Will AI agents make the open web more honest?',
    'technology', 'worldwide', NULL, NULL,
    now() + interval '30 days'),
  ('10000000-0000-0000-0000-000000000002',
    '00000000-0000-0000-0000-000000000002',
    'Do you get at least two hours of deep work on a typical day?',
    'work', 'worldwide', NULL, NULL,
    now() + interval '30 days'),
  ('10000000-0000-0000-0000-000000000003',
    '00000000-0000-0000-0000-000000000003',
    'Did one new habit genuinely improve your life this year?',
    'life', 'worldwide', NULL, NULL,
    now() + interval '21 days'),
  ('10000000-0000-0000-0000-000000000004',
    '00000000-0000-0000-0000-000000000004',
    'Should there be a single global price on carbon?',
    'climate', 'worldwide', NULL, NULL,
    now() + interval '45 days'),
  ('10000000-0000-0000-0000-000000000005',
    '00000000-0000-0000-0000-000000000005',
    'Is remote work better than working from an office?',
    'work', 'worldwide', NULL, NULL,
    now() + interval '30 days'),

  -- Continent: Europe
  ('20000000-0000-0000-0000-000000000001',
    '00000000-0000-0000-0000-000000000004',
    'Should the EU require open-source AI for public services?',
    'policy', 'continent', NULL, 'EU',
    now() + interval '20 days'),
  ('20000000-0000-0000-0000-000000000002',
    '00000000-0000-0000-0000-000000000008',
    'Has rail across Europe gotten meaningfully better in the last 5 years?',
    'travel', 'continent', NULL, 'EU',
    now() + interval '30 days'),

  -- Continent: North America
  ('20000000-0000-0000-0000-000000000003',
    '00000000-0000-0000-0000-000000000005',
    'Is housing affordability a solvable problem in your city?',
    'housing', 'continent', NULL, 'NA',
    now() + interval '30 days'),
  ('20000000-0000-0000-0000-000000000004',
    '00000000-0000-0000-0000-000000000001',
    'Should public transit be free at the point of use?',
    'transport', 'continent', NULL, 'NA',
    now() + interval '25 days'),

  -- Continent: Asia
  ('20000000-0000-0000-0000-000000000005',
    '00000000-0000-0000-0000-00000000000a',
    'Is the shift to mobile-first payments still accelerating?',
    'fintech', 'continent', NULL, 'AS',
    now() + interval '30 days'),
  ('20000000-0000-0000-0000-000000000006',
    '00000000-0000-0000-0000-000000000007',
    'Are smaller Asian cities now better places to live than the megacities?',
    'travel', 'continent', NULL, 'AS',
    now() + interval '40 days'),

  -- Continent: South America
  ('20000000-0000-0000-0000-000000000007',
    '00000000-0000-0000-0000-000000000009',
    'Is informal employment still the dominant reality across the region?',
    'economy', 'continent', NULL, 'SA',
    now() + interval '30 days'),

  -- Continent: Africa
  ('20000000-0000-0000-0000-000000000008',
    '00000000-0000-0000-0000-00000000000c',
    'Will renewable energy be the continent''s biggest job creator by 2030?',
    'economy', 'continent', NULL, 'AF',
    now() + interval '60 days'),

  -- Continent: Oceania
  ('20000000-0000-0000-0000-000000000009',
    '00000000-0000-0000-0000-000000000005',
    'Should there be a regional climate-migration framework?',
    'climate', 'continent', NULL, 'OC',
    now() + interval '45 days'),

  -- Country: United States
  ('30000000-0000-0000-0000-000000000001',
    '00000000-0000-0000-0000-000000000005',
    'Should the U.S. raise the federal minimum wage above $15/hr?',
    'policy', 'country', 'US', 'NA',
    now() + interval '30 days'),
  ('30000000-0000-0000-0000-000000000002',
    '00000000-0000-0000-0000-000000000001',
    'Would you support replacing income tax with a land-value tax?',
    'policy', 'country', 'US', 'NA',
    now() + interval '40 days'),

  -- Country: Germany
  ('30000000-0000-0000-0000-000000000003',
    '00000000-0000-0000-0000-000000000004',
    'Sollte das Deutschlandticket dauerhaft bei 49€ bleiben?',
    'transport', 'country', 'DE', 'EU',
    now() + interval '30 days'),
  ('30000000-0000-0000-0000-000000000004',
    '00000000-0000-0000-0000-000000000004',
    'Brauchen wir strengere Mietpreisbremsen?',
    'housing', 'country', 'DE', 'EU',
    now() + interval '30 days'),

  -- Country: Japan
  ('30000000-0000-0000-0000-000000000005',
    '00000000-0000-0000-0000-000000000002',
    'Has Japan''s push for English-medium tech jobs changed the hiring market?',
    'work', 'country', 'JP', 'AS',
    now() + interval '30 days'),
  ('30000000-0000-0000-0000-000000000006',
    '00000000-0000-0000-0000-00000000000a',
    'Will the four-day work week catch on outside trial companies?',
    'work', 'country', 'JP', 'AS',
    now() + interval '45 days'),

  -- Country: Brazil
  ('30000000-0000-0000-0000-000000000007',
    '00000000-0000-0000-0000-000000000003',
    'O Pix mudou permanentemente como você lida com dinheiro?',
    'fintech', 'country', 'BR', 'SA',
    now() + interval '30 days'),

  -- Country: India
  ('30000000-0000-0000-0000-000000000008',
    '00000000-0000-0000-0000-000000000007',
    'Will UPI volume still double in the next three years?',
    'fintech', 'country', 'IN', 'AS',
    now() + interval '35 days'),

  -- Country: United Kingdom
  ('30000000-0000-0000-0000-000000000009',
    '00000000-0000-0000-0000-000000000008',
    'Is the NHS reformable without a fundamentally different model?',
    'policy', 'country', 'GB', 'EU',
    now() + interval '30 days'),

  -- Country: Australia
  ('30000000-0000-0000-0000-00000000000a',
    '00000000-0000-0000-0000-000000000005',
    'Should the housing tax breaks for investors finally be wound back?',
    'housing', 'country', 'AU', 'OC',
    now() + interval '30 days'),

  -- Country: Nigeria
  ('30000000-0000-0000-0000-00000000000b',
    '00000000-0000-0000-0000-00000000000c',
    'Is the fuel-subsidy removal starting to pay off?',
    'economy', 'country', 'NG', 'AF',
    now() + interval '30 days'),

  -- Country: France
  ('30000000-0000-0000-0000-00000000000c',
    '00000000-0000-0000-0000-000000000004',
    'La semaine de 4 jours, est-ce viable dans le secteur public ?',
    'work', 'country', 'FR', 'EU',
    now() + interval '30 days')
ON CONFLICT (id) DO NOTHING;

-- Helper: insert a batch of envelopes for one question, then write the
-- matching aggregate row in one go. Each envelope gets a synthetic
-- agent_signature / delegation_hash — fine for demo, since the verifier
-- doesn't run against seeded data. Answers lead with Yes/No so they classify.
--
-- We use a CTE-per-question pattern so each block is self-contained.

-- Q1: AI agents
WITH env AS (
  INSERT INTO envelopes (question_id, unique_identifier, answer, disclosed_predicates, agent_signature, delegation_hash) VALUES
    ('10000000-0000-0000-0000-000000000001', 'seed-q1-u1', 'Yes — auditability finally beats virality.', '{"region":"EU","age_band":"25-34"}', 'sig-seed-1', 'del-seed-1'),
    ('10000000-0000-0000-0000-000000000001', 'seed-q1-u2', 'No. Spam scales faster than trust.', '{"region":"NA","age_band":"35-44"}', 'sig-seed-2', 'del-seed-2'),
    ('10000000-0000-0000-0000-000000000001', 'seed-q1-u3', 'No — honest with the few, noisy with the many.', '{"region":"AS","age_band":"25-34"}', 'sig-seed-3', 'del-seed-3'),
    ('10000000-0000-0000-0000-000000000001', 'seed-q1-u4', 'Yes, eventually. The first 18 months will be ugly.', '{"region":"EU","age_band":"45-54"}', 'sig-seed-4', 'del-seed-4'),
    ('10000000-0000-0000-0000-000000000001', 'seed-q1-u5', 'No. Same incentives, faster tooling.', '{"region":"SA","age_band":"25-34"}', 'sig-seed-5', 'del-seed-5'),
    ('10000000-0000-0000-0000-000000000001', 'seed-q1-u6', 'Yes — verified humans become the scarce signal.', '{"region":"NA","age_band":"25-34"}', 'sig-seed-6', 'del-seed-6'),
    ('10000000-0000-0000-0000-000000000001', 'seed-q1-u7', 'No. Surveillance plus automation never ends well.', '{"region":"AF","age_band":"18-24"}', 'sig-seed-7', 'del-seed-7')
  ON CONFLICT DO NOTHING RETURNING 1
)
INSERT INTO aggregates (question_id, total_answers, by_predicate) VALUES
  ('10000000-0000-0000-0000-000000000001', 142,
   '{"region:EU":{"yes":30,"no":18},"region:NA":{"yes":17,"no":25},"region:AS":{"yes":16,"no":15},"region:SA":{"yes":8,"no":4},"region:AF":{"yes":3,"no":6},"age_band:18-24":{"yes":12,"no":5},"age_band:25-34":{"yes":36,"no":25},"age_band:35-44":{"yes":18,"no":22},"age_band:45-54":{"yes":9,"no":15},"country:DE":{"yes":7,"no":5},"country:FR":{"yes":5,"no":3},"country:GB":{"yes":5,"no":3},"country:ES":{"yes":4,"no":2},"country:IT":{"yes":4,"no":2},"country:NL":{"yes":3,"no":2},"country:SE":{"yes":2,"no":1},"country:US":{"yes":10,"no":15},"country:CA":{"yes":4,"no":6},"country:MX":{"yes":3,"no":4},"country:CN":{"yes":4,"no":4},"country:IN":{"yes":4,"no":4},"country:JP":{"yes":3,"no":3},"country:ID":{"yes":3,"no":2},"country:KR":{"yes":2,"no":2},"country:BR":{"yes":4,"no":2},"country:AR":{"yes":2,"no":1},"country:CO":{"yes":1,"no":1},"country:CL":{"yes":1,"no":0},"country:NG":{"yes":1,"no":2},"country:ZA":{"yes":1,"no":2},"country:EG":{"yes":1,"no":1},"country:KE":{"yes":0,"no":1}}')
ON CONFLICT (question_id) DO UPDATE SET total_answers = EXCLUDED.total_answers, by_predicate = EXCLUDED.by_predicate;

-- Q2: deep work hours
WITH env AS (
  INSERT INTO envelopes (question_id, unique_identifier, answer, disclosed_predicates, agent_signature, delegation_hash) VALUES
    ('10000000-0000-0000-0000-000000000002', 'seed-q2-u1', 'No — two on good days, zero on most.', '{"region":"EU","occupation":"engineer"}', 'sig-q2-1', 'del-q2-1'),
    ('10000000-0000-0000-0000-000000000002', 'seed-q2-u2', 'Yes, if I block calendar and disable notifications.', '{"region":"NA","occupation":"engineer"}', 'sig-q2-2', 'del-q2-2'),
    ('10000000-0000-0000-0000-000000000002', 'seed-q2-u3', 'No. Meetings shred the morning.', '{"region":"NA","occupation":"manager"}', 'sig-q2-3', 'del-q2-3'),
    ('10000000-0000-0000-0000-000000000002', 'seed-q2-u4', 'Yes, 5+, but I work asynchronously.', '{"region":"EU","occupation":"writer"}', 'sig-q2-4', 'del-q2-4'),
    ('10000000-0000-0000-0000-000000000002', 'seed-q2-u5', 'No, maybe 90 minutes total.', '{"region":"AS","occupation":"designer"}', 'sig-q2-5', 'del-q2-5')
  ON CONFLICT DO NOTHING RETURNING 1
)
INSERT INTO aggregates (question_id, total_answers, by_predicate) VALUES
  ('10000000-0000-0000-0000-000000000002', 97,
   '{"region:NA":{"yes":14,"no":20},"region:EU":{"yes":15,"no":18},"region:AS":{"yes":7,"no":11},"region:SA":{"yes":3,"no":4},"region:OC":{"yes":3,"no":2},"occupation:engineer":{"yes":22,"no":19},"occupation:manager":{"yes":5,"no":17},"occupation:writer":{"yes":7,"no":4},"occupation:designer":{"yes":6,"no":7},"occupation:other":{"yes":4,"no":6},"country:US":{"yes":8,"no":12},"country:CA":{"yes":3,"no":4},"country:MX":{"yes":3,"no":4},"country:DE":{"yes":3,"no":5},"country:FR":{"yes":3,"no":3},"country:GB":{"yes":3,"no":3},"country:ES":{"yes":2,"no":2},"country:IT":{"yes":2,"no":2},"country:NL":{"yes":1,"no":2},"country:SE":{"yes":1,"no":1},"country:CN":{"yes":2,"no":3},"country:IN":{"yes":2,"no":3},"country:JP":{"yes":1,"no":2},"country:ID":{"yes":1,"no":2},"country:KR":{"yes":1,"no":1},"country:BR":{"yes":2,"no":2},"country:AR":{"yes":1,"no":1},"country:CO":{"yes":0,"no":1},"country:AU":{"yes":2,"no":1},"country:NZ":{"yes":1,"no":1}}')
ON CONFLICT (question_id) DO UPDATE SET total_answers = EXCLUDED.total_answers, by_predicate = EXCLUDED.by_predicate;

-- Q3: one good habit
WITH env AS (
  INSERT INTO envelopes (question_id, unique_identifier, answer, disclosed_predicates, agent_signature, delegation_hash) VALUES
    ('10000000-0000-0000-0000-000000000003', 'seed-q3-u1', 'Yes — phone in another room before bed.', '{"region":"EU","age_band":"25-34"}', 'sig-q3-1', 'del-q3-1'),
    ('10000000-0000-0000-0000-000000000003', 'seed-q3-u2', 'Yes, a morning walk with no audio at all.', '{"region":"NA","age_band":"35-44"}', 'sig-q3-2', 'del-q3-2'),
    ('10000000-0000-0000-0000-000000000003', 'seed-q3-u3', 'Yes — strength training twice a week.', '{"region":"AS","age_band":"25-34"}', 'sig-q3-3', 'del-q3-3'),
    ('10000000-0000-0000-0000-000000000003', 'seed-q3-u4', 'Yes, one journal sentence each night.', '{"region":"OC","age_band":"45-54"}', 'sig-q3-4', 'del-q3-4')
  ON CONFLICT DO NOTHING RETURNING 1
)
INSERT INTO aggregates (question_id, total_answers, by_predicate) VALUES
  ('10000000-0000-0000-0000-000000000003', 88,
   '{"region:EU":{"yes":22,"no":7},"region:NA":{"yes":19,"no":7},"region:AS":{"yes":14,"no":4},"region:OC":{"yes":6,"no":2},"region:SA":{"yes":5,"no":2},"age_band:18-24":{"yes":8,"no":3},"age_band:25-34":{"yes":28,"no":8},"age_band:35-44":{"yes":19,"no":7},"age_band:45-54":{"yes":11,"no":4},"country:DE":{"yes":5,"no":2},"country:FR":{"yes":4,"no":1},"country:GB":{"yes":4,"no":1},"country:ES":{"yes":3,"no":1},"country:IT":{"yes":3,"no":1},"country:NL":{"yes":2,"no":1},"country:SE":{"yes":1,"no":0},"country:US":{"yes":11,"no":4},"country:CA":{"yes":4,"no":2},"country:MX":{"yes":4,"no":1},"country:CN":{"yes":4,"no":1},"country:IN":{"yes":4,"no":1},"country:JP":{"yes":2,"no":1},"country:ID":{"yes":2,"no":1},"country:KR":{"yes":2,"no":0},"country:AU":{"yes":4,"no":1},"country:NZ":{"yes":2,"no":1},"country:BR":{"yes":2,"no":1},"country:AR":{"yes":1,"no":1},"country:CO":{"yes":1,"no":0},"country:CL":{"yes":1,"no":0}}')
ON CONFLICT (question_id) DO UPDATE SET total_answers = EXCLUDED.total_answers, by_predicate = EXCLUDED.by_predicate;

-- Q4: global carbon price
INSERT INTO aggregates (question_id, total_answers, by_predicate) VALUES
  ('10000000-0000-0000-0000-000000000004', 213,
   '{"region:EU":{"yes":58,"no":20},"region:NA":{"yes":24,"no":30},"region:AS":{"yes":26,"no":15},"region:SA":{"yes":12,"no":6},"region:AF":{"yes":9,"no":6},"region:OC":{"yes":4,"no":3},"age_band:18-24":{"yes":38,"no":10},"age_band:25-34":{"yes":52,"no":28},"age_band:35-44":{"yes":30,"no":25},"age_band:45-54":{"yes":13,"no":17},"country:DE":{"yes":14,"no":5},"country:FR":{"yes":11,"no":4},"country:GB":{"yes":10,"no":4},"country:ES":{"yes":7,"no":2},"country:IT":{"yes":7,"no":2},"country:NL":{"yes":5,"no":2},"country:SE":{"yes":4,"no":1},"country:US":{"yes":15,"no":18},"country:CA":{"yes":5,"no":7},"country:MX":{"yes":4,"no":5},"country:CN":{"yes":7,"no":4},"country:IN":{"yes":7,"no":4},"country:JP":{"yes":5,"no":3},"country:ID":{"yes":4,"no":2},"country:KR":{"yes":3,"no":2},"country:BR":{"yes":6,"no":3},"country:AR":{"yes":2,"no":1},"country:CO":{"yes":2,"no":1},"country:CL":{"yes":2,"no":1},"country:NG":{"yes":3,"no":2},"country:ZA":{"yes":3,"no":2},"country:EG":{"yes":2,"no":1},"country:KE":{"yes":1,"no":1},"country:AU":{"yes":3,"no":2},"country:NZ":{"yes":1,"no":1}}')
ON CONFLICT (question_id) DO UPDATE SET total_answers = EXCLUDED.total_answers, by_predicate = EXCLUDED.by_predicate;
INSERT INTO envelopes (question_id, unique_identifier, answer, disclosed_predicates, agent_signature, delegation_hash) VALUES
  ('10000000-0000-0000-0000-000000000004', 'seed-q4-u1', 'Yes — a simple global carbon price, refunded as a dividend.', '{"region":"EU","age_band":"25-34"}', 'sig-q4-1', 'del-q4-1'),
  ('10000000-0000-0000-0000-000000000004', 'seed-q4-u2', 'No — end fossil-fuel subsidies first.', '{"region":"NA","age_band":"35-44"}', 'sig-q4-2', 'del-q4-2'),
  ('10000000-0000-0000-0000-000000000004', 'seed-q4-u3', 'Yes, paired with direct grid-storage funding.', '{"region":"AS","age_band":"25-34"}', 'sig-q4-3', 'del-q4-3')
ON CONFLICT DO NOTHING;

-- Q5: remote vs office
INSERT INTO aggregates (question_id, total_answers, by_predicate) VALUES
  ('10000000-0000-0000-0000-000000000005', 174,
   '{"region:NA":{"yes":40,"no":31},"region:EU":{"yes":30,"no":23},"region:AS":{"yes":13,"no":16},"region:SA":{"yes":7,"no":5},"region:OC":{"yes":5,"no":4},"occupation:engineer":{"yes":47,"no":21},"occupation:designer":{"yes":12,"no":9},"occupation:writer":{"yes":13,"no":5},"occupation:manager":{"yes":11,"no":23},"occupation:other":{"yes":16,"no":17},"country:US":{"yes":24,"no":19},"country:CA":{"yes":9,"no":7},"country:MX":{"yes":7,"no":5},"country:DE":{"yes":7,"no":5},"country:FR":{"yes":5,"no":4},"country:GB":{"yes":5,"no":4},"country:ES":{"yes":4,"no":3},"country:IT":{"yes":4,"no":3},"country:NL":{"yes":3,"no":2},"country:SE":{"yes":2,"no":2},"country:CN":{"yes":4,"no":4},"country:IN":{"yes":3,"no":4},"country:JP":{"yes":2,"no":3},"country:ID":{"yes":2,"no":3},"country:KR":{"yes":2,"no":2},"country:BR":{"yes":4,"no":2},"country:AR":{"yes":1,"no":1},"country:CO":{"yes":1,"no":1},"country:CL":{"yes":1,"no":1},"country:AU":{"yes":4,"no":3},"country:NZ":{"yes":1,"no":1}}')
ON CONFLICT (question_id) DO UPDATE SET total_answers = EXCLUDED.total_answers, by_predicate = EXCLUDED.by_predicate;
INSERT INTO envelopes (question_id, unique_identifier, answer, disclosed_predicates, agent_signature, delegation_hash) VALUES
  ('10000000-0000-0000-0000-000000000005', 'seed-q5-u1', 'Yes for execution, though worse for serendipity.', '{"region":"NA","occupation":"engineer"}', 'sig-q5-1', 'del-q5-1'),
  ('10000000-0000-0000-0000-000000000005', 'seed-q5-u2', 'No — both have a mode tax, and the office wins for me.', '{"region":"EU","occupation":"manager"}', 'sig-q5-2', 'del-q5-2')
ON CONFLICT DO NOTHING;

-- Continent questions
INSERT INTO aggregates (question_id, total_answers, by_predicate) VALUES
  ('20000000-0000-0000-0000-000000000001', 64,
   '{"country:DE":{"yes":12,"no":6},"country:FR":{"yes":6,"no":5},"country:NL":{"yes":6,"no":2},"country:ES":{"yes":5,"no":2},"country:IT":{"yes":3,"no":3},"country:SE":{"yes":4,"no":1},"country:PL":{"yes":2,"no":2},"country:other":{"yes":3,"no":2},"age_band:25-34":{"yes":20,"no":8},"age_band:35-44":{"yes":13,"no":8},"age_band:45-54":{"yes":8,"no":7}}'),
  ('20000000-0000-0000-0000-000000000002', 41,
   '{"country:DE":{"yes":7,"no":5},"country:FR":{"yes":6,"no":3},"country:IT":{"yes":2,"no":4},"country:CH":{"yes":4,"no":1},"country:AT":{"yes":2,"no":2},"country:NL":{"yes":2,"no":1},"country:other":{"yes":1,"no":1}}'),
  ('20000000-0000-0000-0000-000000000003', 89,
   '{"country:US":{"yes":31,"no":27},"country:CA":{"yes":9,"no":12},"country:MX":{"yes":6,"no":4},"age_band:25-34":{"yes":19,"no":15},"age_band:35-44":{"yes":14,"no":16},"age_band:45-54":{"yes":7,"no":10},"age_band:18-24":{"yes":6,"no":2}}'),
  ('20000000-0000-0000-0000-000000000004', 73,
   '{"country:US":{"yes":27,"no":20},"country:CA":{"yes":12,"no":6},"country:MX":{"yes":6,"no":2},"age_band:25-34":{"yes":20,"no":9},"age_band:35-44":{"yes":14,"no":10},"age_band:45-54":{"yes":5,"no":7},"age_band:18-24":{"yes":6,"no":2}}'),
  ('20000000-0000-0000-0000-000000000005', 58,
   '{"country:CN":{"yes":11,"no":6},"country:IN":{"yes":12,"no":3},"country:JP":{"yes":4,"no":6},"country:KR":{"yes":3,"no":4},"country:SG":{"yes":2,"no":2},"country:ID":{"yes":3,"no":0},"country:VN":{"yes":2,"no":0}}'),
  ('20000000-0000-0000-0000-000000000006', 47,
   '{"country:JP":{"yes":7,"no":6},"country:KR":{"yes":5,"no":4},"country:TW":{"yes":4,"no":3},"country:TH":{"yes":4,"no":2},"country:VN":{"yes":3,"no":2},"country:MY":{"yes":2,"no":2},"country:other":{"yes":1,"no":2}}'),
  ('20000000-0000-0000-0000-000000000007', 35,
   '{"country:BR":{"yes":10,"no":5},"country:AR":{"yes":5,"no":2},"country:CO":{"yes":4,"no":2},"country:CL":{"yes":2,"no":2},"country:PE":{"yes":2,"no":1}}'),
  ('20000000-0000-0000-0000-000000000008', 29,
   '{"country:NG":{"yes":5,"no":4},"country:ZA":{"yes":3,"no":4},"country:KE":{"yes":3,"no":2},"country:EG":{"yes":2,"no":2},"country:MA":{"yes":1,"no":1},"country:other":{"yes":1,"no":1}}'),
  ('20000000-0000-0000-0000-000000000009', 18,
   '{"country:AU":{"yes":6,"no":5},"country:NZ":{"yes":3,"no":2},"country:FJ":{"yes":2,"no":0}}')
ON CONFLICT (question_id) DO UPDATE SET total_answers = EXCLUDED.total_answers, by_predicate = EXCLUDED.by_predicate;

INSERT INTO envelopes (question_id, unique_identifier, answer, disclosed_predicates, agent_signature, delegation_hash) VALUES
  ('20000000-0000-0000-0000-000000000001', 'seed-c1-u1', 'Yes — open weights for any model used in admin decisions.', '{"country":"DE","age_band":"25-34"}', 'sig-c1-1', 'del-c1-1'),
  ('20000000-0000-0000-0000-000000000001', 'seed-c1-u2', 'No — only above a usage threshold; don''t kneecap startups.', '{"country":"FR","age_band":"35-44"}', 'sig-c1-2', 'del-c1-2'),
  ('20000000-0000-0000-0000-000000000001', 'seed-c1-u3', 'Yes, and require reproducible training datasets.', '{"country":"NL","age_band":"25-34"}', 'sig-c1-3', 'del-c1-3'),
  ('20000000-0000-0000-0000-000000000002', 'seed-c2-u1', 'Yes for high-speed rail; regional services still lag.', '{"country":"DE","age_band":"35-44"}', 'sig-c2-1', 'del-c2-1'),
  ('20000000-0000-0000-0000-000000000003', 'seed-c3-u1', 'Yes — solvable, we just refuse to build.', '{"country":"US","age_band":"25-34"}', 'sig-c3-1', 'del-c3-1'),
  ('20000000-0000-0000-0000-000000000003', 'seed-c3-u2', 'No — only by killing zoning, which won''t happen here.', '{"country":"CA","age_band":"35-44"}', 'sig-c3-2', 'del-c3-2'),
  ('20000000-0000-0000-0000-000000000004', 'seed-c4-u1', 'Yes — congestion, equity, climate. All three.', '{"country":"CA","age_band":"25-34"}', 'sig-c4-1', 'del-c4-1'),
  ('20000000-0000-0000-0000-000000000005', 'seed-c5-u1', 'Yes — still accelerating across Southeast Asia.', '{"country":"SG","age_band":"35-44"}', 'sig-c5-1', 'del-c5-1'),
  ('20000000-0000-0000-0000-000000000006', 'seed-c6-u1', 'Yes — Fukuoka beats Tokyo on cost and calm.', '{"country":"JP","age_band":"25-34"}', 'sig-c6-1', 'del-c6-1'),
  ('20000000-0000-0000-0000-000000000007', 'seed-c7-u1', 'Yes — dominant by headcount, even if shrinking in revenue.', '{"country":"BR","age_band":"35-44"}', 'sig-c7-1', 'del-c7-1'),
  ('20000000-0000-0000-0000-000000000008', 'seed-c8-u1', 'Yes — renewable installation and operations will lead.', '{"country":"NG","age_band":"25-34"}', 'sig-c8-1', 'del-c8-1'),
  ('20000000-0000-0000-0000-000000000009', 'seed-c9-u1', 'Yes — Pacific Islands can''t wait for global frameworks.', '{"country":"AU","age_band":"35-44"}', 'sig-c9-1', 'del-c9-1')
ON CONFLICT DO NOTHING;

-- Country questions
INSERT INTO aggregates (question_id, total_answers, by_predicate) VALUES
  ('30000000-0000-0000-0000-000000000001', 312,
   '{"region:northeast":{"yes":52,"no":29},"region:south":{"yes":41,"no":57},"region:midwest":{"yes":28,"no":35},"region:west":{"yes":47,"no":23},"age_band:18-24":{"yes":46,"no":15},"age_band:25-34":{"yes":70,"no":48},"age_band:35-44":{"yes":36,"no":38},"age_band:45-54":{"yes":12,"no":30},"age_band:55+":{"yes":4,"no":13}}'),
  ('30000000-0000-0000-0000-000000000002', 184,
   '{"region:northeast":{"yes":26,"no":26},"region:south":{"yes":18,"no":30},"region:midwest":{"yes":14,"no":22},"region:west":{"yes":24,"no":24},"age_band:25-34":{"yes":38,"no":33},"age_band:35-44":{"yes":24,"no":28},"age_band:45-54":{"yes":14,"no":26},"age_band:55+":{"yes":6,"no":15}}'),
  ('30000000-0000-0000-0000-000000000003', 96,
   '{"region:Berlin":{"yes":15,"no":6},"region:München":{"yes":11,"no":7},"region:Hamburg":{"yes":10,"no":4},"region:NRW":{"yes":14,"no":8},"region:other":{"yes":12,"no":9},"age_band:25-34":{"yes":25,"no":9},"age_band:35-44":{"yes":19,"no":10},"age_band:45-54":{"yes":12,"no":9},"age_band:18-24":{"yes":6,"no":6}}'),
  ('30000000-0000-0000-0000-000000000004', 73,
   '{"region:Berlin":{"yes":12,"no":6},"region:München":{"yes":6,"no":8},"region:Hamburg":{"yes":6,"no":5},"region:other":{"yes":14,"no":16},"age_band:25-34":{"yes":15,"no":10},"age_band:35-44":{"yes":12,"no":12},"age_band:45-54":{"yes":6,"no":9},"age_band:18-24":{"yes":5,"no":4}}'),
  ('30000000-0000-0000-0000-000000000005', 54,
   '{"region:Tokyo":{"yes":15,"no":9},"region:Osaka":{"yes":5,"no":6},"region:Kyushu":{"yes":3,"no":5},"region:other":{"yes":5,"no":6},"age_band:25-34":{"yes":13,"no":8},"age_band:35-44":{"yes":9,"no":9},"age_band:45-54":{"yes":4,"no":7},"age_band:18-24":{"yes":2,"no":2}}'),
  ('30000000-0000-0000-0000-000000000006', 39,
   '{"region:Tokyo":{"yes":7,"no":8},"region:Osaka":{"yes":4,"no":5},"region:other":{"yes":6,"no":9},"age_band:25-34":{"yes":9,"no":7},"age_band:35-44":{"yes":5,"no":9},"age_band:45-54":{"yes":2,"no":5},"age_band:18-24":{"yes":1,"no":1}}'),
  ('30000000-0000-0000-0000-000000000007', 121,
   '{"region:Sudeste":{"yes":44,"no":8},"region:Sul":{"yes":19,"no":5},"region:Nordeste":{"yes":23,"no":5},"region:Norte":{"yes":5,"no":2},"region:CentroOeste":{"yes":8,"no":2}}'),
  ('30000000-0000-0000-0000-000000000008', 168,
   '{"region:North":{"yes":28,"no":14},"region:South":{"yes":33,"no":15},"region:West":{"yes":27,"no":14},"region:East":{"yes":22,"no":15},"age_band:18-24":{"yes":44,"no":14},"age_band:25-34":{"yes":50,"no":24},"age_band:35-44":{"yes":13,"no":13},"age_band:45-54":{"yes":3,"no":7}}'),
  ('30000000-0000-0000-0000-000000000009', 92,
   '{"region:England":{"yes":28,"no":33},"region:Scotland":{"yes":6,"no":9},"region:Wales":{"yes":4,"no":5},"region:NI":{"yes":3,"no":4},"age_band:25-34":{"yes":16,"no":15},"age_band:35-44":{"yes":13,"no":15},"age_band:45-54":{"yes":8,"no":11},"age_band:55+":{"yes":4,"no":10}}'),
  ('30000000-0000-0000-0000-00000000000a', 47,
   '{"region:NSW":{"yes":11,"no":6},"region:VIC":{"yes":9,"no":5},"region:QLD":{"yes":4,"no":4},"region:WA":{"yes":3,"no":2},"region:other":{"yes":2,"no":1}}'),
  ('30000000-0000-0000-0000-00000000000b', 56,
   '{"region:Lagos":{"yes":9,"no":15},"region:Abuja":{"yes":5,"no":6},"region:South":{"yes":4,"no":8},"region:North":{"yes":3,"no":6}}'),
  ('30000000-0000-0000-0000-00000000000c', 62,
   '{"region:IDF":{"yes":10,"no":9},"region:Sud":{"yes":6,"no":7},"region:Ouest":{"yes":6,"no":5},"region:Est":{"yes":4,"no":5},"region:Nord":{"yes":5,"no":5}}')
ON CONFLICT (question_id) DO UPDATE SET total_answers = EXCLUDED.total_answers, by_predicate = EXCLUDED.by_predicate;

INSERT INTO envelopes (question_id, unique_identifier, answer, disclosed_predicates, agent_signature, delegation_hash) VALUES
  ('30000000-0000-0000-0000-000000000001', 'seed-us1-u1', 'Yes, indexed to median rent — $15 already lags.', '{"region":"northeast","age_band":"25-34"}', 'sig-us1-1', 'del-us1-1'),
  ('30000000-0000-0000-0000-000000000001', 'seed-us1-u2', 'Yes, but only with regional bands.', '{"region":"south","age_band":"35-44"}', 'sig-us1-2', 'del-us1-2'),
  ('30000000-0000-0000-0000-000000000001', 'seed-us1-u3', 'No — small businesses outside coastal cities can''t carry it.', '{"region":"midwest","age_band":"45-54"}', 'sig-us1-3', 'del-us1-3'),
  ('30000000-0000-0000-0000-000000000001', 'seed-us1-u4', 'Yes, with a phase-in for small employers.', '{"region":"west","age_band":"25-34"}', 'sig-us1-4', 'del-us1-4'),
  ('30000000-0000-0000-0000-000000000002', 'seed-us2-u1', 'Yes — capture economic rent, free the productive sector.', '{"region":"northeast","age_band":"25-34"}', 'sig-us2-1', 'del-us2-1'),
  ('30000000-0000-0000-0000-000000000002', 'seed-us2-u2', 'No — in theory yes, but the politics make it impossible.', '{"region":"west","age_band":"35-44"}', 'sig-us2-2', 'del-us2-2'),
  ('30000000-0000-0000-0000-000000000003', 'seed-de1-u1', 'Ja, aber finanziert über eine bundesweite Pendlerumlage.', '{"region":"Berlin","age_band":"25-34"}', 'sig-de1-1', 'del-de1-1'),
  ('30000000-0000-0000-0000-000000000003', 'seed-de1-u2', 'Nein. Die Länder müssen es nachhaltig finanzieren.', '{"region":"München","age_band":"35-44"}', 'sig-de1-2', 'del-de1-2'),
  ('30000000-0000-0000-0000-000000000004', 'seed-de2-u1', 'Ja — der Markt in Berlin braucht strengere Bremsen.', '{"region":"Berlin","age_band":"25-34"}', 'sig-de2-1', 'del-de2-1'),
  ('30000000-0000-0000-0000-000000000005', 'seed-jp1-u1', 'Yes — Tokyo startups hire in English now without controversy.', '{"region":"Tokyo","age_band":"25-34"}', 'sig-jp1-1', 'del-jp1-1'),
  ('30000000-0000-0000-0000-000000000006', 'seed-jp2-u1', 'No — trial wins are real but it won''t generalize soon.', '{"region":"Tokyo","age_band":"35-44"}', 'sig-jp2-1', 'del-jp2-1'),
  ('30000000-0000-0000-0000-000000000007', 'seed-br1-u1', 'Sim — quase não uso dinheiro vivo desde 2022.', '{"region":"Sudeste","age_band":"25-34"}', 'sig-br1-1', 'del-br1-1'),
  ('30000000-0000-0000-0000-000000000007', 'seed-br1-u2', 'Sim, mudou tudo no comércio pequeno.', '{"region":"Nordeste","age_band":"35-44"}', 'sig-br1-2', 'del-br1-2'),
  ('30000000-0000-0000-0000-000000000008', 'seed-in1-u1', 'Yes — rural adoption still has miles to go.', '{"region":"South","age_band":"25-34"}', 'sig-in1-1', 'del-in1-1'),
  ('30000000-0000-0000-0000-000000000008', 'seed-in1-u2', 'Yes — still doubling; rural is the runway.', '{"region":"North","age_band":"35-44"}', 'sig-in1-2', 'del-in1-2'),
  ('30000000-0000-0000-0000-000000000009', 'seed-gb1-u1', 'No — it needs a fundamentally different model, not tweaks.', '{"region":"England","age_band":"35-44"}', 'sig-gb1-1', 'del-gb1-1'),
  ('30000000-0000-0000-0000-00000000000a', 'seed-au1-u1', 'Yes — negative gearing is a fairness problem.', '{"region":"NSW","age_band":"25-34"}', 'sig-au1-1', 'del-au1-1'),
  ('30000000-0000-0000-0000-00000000000b', 'seed-ng1-u1', 'No — painful now, the gains haven''t landed yet.', '{"region":"Lagos","age_band":"25-34"}', 'sig-ng1-1', 'del-ng1-1'),
  ('30000000-0000-0000-0000-00000000000c', 'seed-fr1-u1', 'Oui, viable dans certains services; pas partout.', '{"region":"IDF","age_band":"35-44"}', 'sig-fr1-1', 'del-fr1-1')
ON CONFLICT DO NOTHING;

COMMIT;
