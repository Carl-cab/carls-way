DROP TABLE IF EXISTS tmp_float_money_check;
CREATE TEMP TABLE tmp_float_money_check (
  amount REAL NOT NULL
);

INSERT INTO tmp_float_money_check (amount) VALUES (9999999.99), (100.00);

SELECT
  amount::text AS stored_large_amount,
  (100::REAL - (0.10::REAL * 7))::text AS repeated_subtraction_result,
  ((100::REAL - (0.10::REAL * 7)) - 99.30::REAL)::text AS difference_from_exact_99_30
FROM tmp_float_money_check
WHERE amount > 1000000;

DROP TABLE tmp_float_money_check;
