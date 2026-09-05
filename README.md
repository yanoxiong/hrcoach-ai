# HRCoach AI — Online MVP

This is the first deployable full-stack version of HRCoach AI.

## Included
- Real account registration and sign-in
- Password hashing
- Company-separated employee data
- Employee profiles
- Saved HRCoach records
- Ask HRCoach
- Documentation Assistant
- Difficult Conversation Coach
- Recognition Generator
- Server-side OpenAI integration
- Demo AI mode so you can test without API charges
- Rate limiting and basic security headers
- Company account deletion

## Important
This is an MVP, not a compliance certification. Do not use it for confidential production HR records until you have completed appropriate security, privacy, legal, retention, backup, and incident-response work.

HRCoach is designed to support managers, not make employment decisions or provide legal advice.

## Run on Windows

1. Install Node.js 20 or newer from nodejs.org.
2. Unzip this project.
3. Open Command Prompt or PowerShell inside the project folder.
4. Run:

   npm install

5. Copy `.env.example` to `.env`.
6. Change `JWT_SECRET` to a long random string.
7. Leave `DEMO_MODE=true` at first.
8. Run:

   npm start

9. Open:

   http://localhost:3000

## Turn on live AI

1. Create an OpenAI API key in your OpenAI API account.
2. Put it only in `.env`:

   OPENAI_API_KEY=your_key_here

3. Set:

   DEMO_MODE=false

4. Restart:

   npm start

The API key is never sent to the browser.

The default model in `.env.example` is `gpt-5.6-luna`, selected as a cost-sensitive model. You can change `OPENAI_MODEL` later.

## Put it online

The easiest architecture for this MVP is a Node.js host with persistent storage.

### Generic deployment steps
1. Put this folder in a private Git repository.
2. Create a Node web service at your hosting provider.
3. Build command:
   npm install
4. Start command:
   npm start
5. Add environment variables:
   JWT_SECRET
   OPENAI_API_KEY
   OPENAI_MODEL
   DEMO_MODE=false
   DATABASE_PATH=/persistent/path/hrcoach.db
6. Attach persistent disk/storage and point DATABASE_PATH to it.
7. Add your custom domain after the service works.
8. Enable HTTPS (most modern hosts do this automatically).

### Before taking paying customers
- Replace SQLite with managed Postgres once usage grows or if your hosting setup does not guarantee durable disk storage.
- Add email verification/password reset.
- Add role-based permissions for multiple managers.
- Add audit logs.
- Add encrypted backups.
- Add subscription billing.
- Add a privacy policy, terms, data processing terms, retention/deletion policy, and incident response plan.
- Obtain appropriate professional legal/privacy/security review before handling real sensitive employment records.

## First customer test
Use fictional data and have 5-10 managers try:
- Ask HRCoach
- Conversation Coach
- Documentation
- Recognition

Measure which feature they would pay for before adding payroll, scheduling, recruiting, or other large HRIS features.

## Stripe sandbox billing
Required environment variables:
- `STRIPE_SECRET_KEY` (sandbox `sk_test_...`)
- `STRIPE_WEBHOOK_SECRET` (`whsec_...` from the sandbox destination)
- `STRIPE_PRICE_FOUNDING=price_1UCEv9JJ6FKimMlwcQl9i8G9`
- `STRIPE_PRICE_BUSINESS=price_1UCEwZJJ6FKimMlwldpvXG5U`

Webhook endpoint: `https://hrcoachapp.com/api/stripe/webhook`
Events: `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.payment_failed`, `invoice.paid`.

Checkout requires a payment method and starts a 14-day trial. Before production launch, replace all sandbox Stripe values with matching live-mode keys/prices and create a live webhook destination.
