SELECT
  (100::REAL - (0.10::REAL * 7))::text AS rendered_real,
  (100::REAL - (0.10::REAL * 7))::numeric AS numeric_cast,
  ((100::REAL - (0.10::REAL * 7))::double precision)::numeric AS double_to_numeric_cast,
  ROUND(((100::REAL - (0.10::REAL * 7))::double precision)::numeric, 2) AS rounded_cents;
