# Platform account deletion saga

Both `DELETE /auth/account` and `DELETE /auth/admin/users/:id` insert one
`deletion_jobs` row and six fixed `deletion_job_targets` rows in the same
SQLite transaction before deleting the identity. A persistence failure rolls
back the identity deletion. Jobs intentionally have no user foreign key, so
their bounded operational status remains visible after the user row is gone.

The worker leases one target, signs a fresh five-minute RS256 JWT with exact
`hof-deletion:<service>` audience, `token_use=deletion`,
`scope=account:delete`, subject, job ID, and unique token ID, then posts the
strict subject/job body to the deployment-owned target URL. Timeouts, `408`,
`429`, and `5xx` responses use bounded full-jitter backoff. Other failures and
the configured attempt limit become permanent. Jobs finish `completed` only
when every target confirms; any permanent target produces `failed` after all
targets settle.

Administrators can inspect the latest 100 jobs at
`GET /auth/admin/deletion-jobs` or one job at
`GET /auth/admin/deletion-jobs/:id`. Deploy consumer migrations and endpoints
before enabling this producer.
