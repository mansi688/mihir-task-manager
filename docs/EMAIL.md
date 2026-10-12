# Email → task (`ENABLE_EMAIL_INGESTION`)

Employees forward or CC an email to the company task address (e.g. `tasks@mihirgroup.com`). No access to anyone's
own mailbox. Only senders whose address matches an employee's email in their profile are accepted; each Message-ID is
processed once; the sender gets an in-app notification and reviews the suggestions under **Suggestions**.

## Endpoint
`POST https://<site>/api/integrations/email/inbound`, header `X-Inbound-Secret: <EMAIL_INBOUND_SECRET>`, JSON:
`{ "message_id": "...", "from": "Name <a@mihirgroup.com>", "to": "...", "cc": "...", "subject": "...", "text": "...",
"attachments": [{ "name": "...", "size": 123 }] }`

## Connecting the mailbox — depends on where mihirgroup.com mail is hosted (still to confirm)
- **Domain DNS on Cloudflare** (any mail host): Cloudflare Email Routing → route `tasks@` to an Email Worker that POSTs the
  message as above (free).
- **Zoho / Google / Microsoft / GoDaddy / Hostinger mailbox**: a forwarding rule on the `tasks@` mailbox to an inbound-parse
  service (Mailgun / SendGrid / Postmark free tiers) configured to POST to the endpoint — or a small scheduled IMAP
  poller (can be added as a job once the host is known).
