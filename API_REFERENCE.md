# Manna App – API Reference

## Core Endpoints

**POST `/api/transactions`**
- **Purpose:** Send or request money.
- **Request:** `{ receiverUsername, amount, note, type: 'pay'|'request', privacy }`
- **Response:** `{ success: true, transactionId, isCrossBorder, receiverAmount, receiverCurrency }`

**PATCH `/api/transactions/[id]`**
- **Purpose:** Accept or decline a pending request.
- **Request:** `{ action: 'accept'|'decline' }`

**POST `/api/fx/quote`**
- **Purpose:** Get a live FX quote before sending cross-border.
- **Request:** `{ amount, fromCurrency, toCurrency }`
- **Response:** `FxQuote` object

**POST `/api/plaid/exchange-token`**
- **Purpose:** Exchange Plaid Link public token for access token.
- **Request:** `{ public_token, metadata }`
