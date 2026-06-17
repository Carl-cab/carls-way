# Manna App – Development Roadmap

## Immediate Priorities
1. Fix the Request Money acceptance bug (`/api/transactions/[id]/route.ts`).
2. Remove the legacy `balance` column and update all queries.
3. Encrypt Plaid access tokens at rest.

## Short Term Roadmap
1. Implement the "Add Money" and "Cash Out" flows using linked bank accounts.
2. Implement the KYC verification flow.

## Long Term Roadmap
1. Introduce a formal database migration tool.
2. Add comprehensive automated testing.
