SELECT
  isfinite(1.25::double precision) AS finite_value,
  isfinite('Infinity'::double precision) AS infinite_value,
  isfinite('NaN'::double precision) AS nan_value;
