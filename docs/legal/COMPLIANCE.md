# Launch compliance report — Alpha CRM

> **Informational, not legal advice.** This is a plain-language summary of what your app does with data (detected from your code) and what you likely need before launch. For anything you're unsure about, use the free resources below or a lawyer.

## What your app does with data

**Collects:**
  - your name
  - your email address
  - an encrypted password or login identifier

**Shares with (third parties that run the product):**
  - Supabase (database, auth & hosting)
  - an email delivery provider (transactional email)

**Uses cookies:** yes

## Before you launch

- **[REQUIRED]** A **privacy policy** describing what you collect and why (you collect personal data — this is legally required in most regions).
- **[REQUIRED]** A **cookie-consent banner** — you use cookies, so EU/UK law requires opt-in consent *before* non-essential cookies run. Use a free open-source banner (see resources) rather than building your own.
- **[REQUIRED]** A **data export & deletion** path for users (GDPR/CCPA give them the right to access and delete their data).
- **[recommended]** A **contact method** for privacy questions (an email is enough to start).

## Starter drafts included

We've generated **template** privacy / terms / cookie documents in this folder (`PRIVACY.md`, `TERMS.md`, `COOKIES.md`) as a *starting point*. They reflect the data practices above, but they are **not legal advice** — review and finalise them with the resources below or a lawyer, and fill in every `[BRACKETED]` placeholder.

## Free resources

- [GDPR overview & checklists (free)](https://gdpr.eu/checklist/)
- [UK ICO — what to put in a privacy notice (free)](https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/individual-rights/)
- [CNIL — cookies & consent guidance (free)](https://www.cnil.fr/en/cookies-and-other-trackers)
- [cookieconsent — open-source consent banner (MIT)](https://github.com/orestbida/cookieconsent)
