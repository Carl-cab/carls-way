import bcrypt from 'bcryptjs';

const password = 'ExamplePassword1';
const malformed = '$2b$10$invalidhashfortimingnormalization';

async function elapsed(fn) {
  const start = process.hrtime.bigint();
  const result = await fn();
  const end = process.hrtime.bigint();
  return { result, milliseconds: Number(end - start) / 1_000_000 };
}

(async () => {
  const validHash = await bcrypt.hash('DifferentPassword1', 10);
  const real = await elapsed(() => bcrypt.compare(password, validHash));
  const dummy = await elapsed(() => bcrypt.compare(password, malformed));
  console.log(JSON.stringify({ real, dummy }, null, 2));
})();
