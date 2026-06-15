# Manna App – Current Project Status

## Executive Summary
Manna is a peer-to-peer payment application designed for cross-border money transfers between the United States and Canada. It allows users to send and request money, manage dual-currency balances, and link bank accounts.

## Current Project Status
The application is deployed to production on Vercel. Core user registration, dual-currency balances, FX quoting, sending money, and Plaid token exchange are implemented. However, there are significant unfinished UI surfaces (e.g., KYC flow, add/withdraw money) and some technical debt regarding the legacy single-currency balance field.

## Completed Features
- Registration & Login
- Send Money & FX Quotes
- Plaid Bank Linking

## In Progress / Unfinished Features
- KYC & Identity Verification
- Add Money / Cash Out
- Friend Requests

## Known Bugs
- Request Money Acceptance Uses Legacy Balance: When a user accepts a pending money request, the backend deducts from the legacy `balance` field instead of `balance_cad` or `balance_usd`, and ignores cross-border FX logic.
