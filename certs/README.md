# Certificates

Public certificate authorities, committed on purpose.

## Why these are in the repository

A CA certificate contains a public key and a signature — nothing secret. It is
the same file every Supabase customer downloads, and publishing it weakens
nothing: an attacker who has it still cannot impersonate the server, because that
needs the CA's _private_ key, which Supabase holds and never distributes.

Committing it is what makes verification work where there is no filesystem to
prepare. Vercel builds from this repository; a certificate sitting in
`~/.config` on a laptop is not present in that environment, so a connection
string pointing there fails at runtime. Bundling it means the deployed app can
verify Supabase's certificate chain rather than trusting whatever answers.

## supabase-ca-2021.crt

    Subject   CN = Supabase Root 2021 CA, O = Supabase Inc
    Issuer    (self-signed root)
    Valid     2021-04-28 → 2031-04-26

Downloaded from the Supabase dashboard: Project Settings → Database → SSL
Configuration. Verified to sign the chain presented by both the direct endpoint
and the pooler:

    db.<ref>.supabase.co  ←  Supabase Intermediate 2021 CA  ←  Supabase Root 2021 CA
    *.pooler.supabase.com ←  Supabase Intermediate 2021 CA  ←  Supabase Root 2021 CA

**It expires in April 2031.** Connections using `sslmode=verify-full` will fail
outright when it does, not degrade quietly. Replace it from the dashboard.

## What must never go in here

Private keys, client certificates with their keys, or anything from
`.env`. If a file's purpose is to prove _our_ identity rather than verify someone
else's, it does not belong in a repository.
