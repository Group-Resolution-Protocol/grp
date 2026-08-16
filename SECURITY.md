# Security Policy

## Reporting a vulnerability

Please email **ops@grp.dev**. Do not open a public issue for anything
you believe is a security vulnerability — in this code, in the protocol
design, or in a hosted GRP operator.

Include what you found, how to reproduce it, and what you believe the
impact is. You'll get an acknowledgment within a few business days, and
we'll keep you informed as we triage and fix.

## Scope

- The packages in this repository (CLI, SDK, audit, conformance, and engine)
  and the specification itself.
- GRP Server Cloud (grp.app), the hosted operator run by Malacan, Inc.

Receipt verification is a security surface: anything that lets an
invalid receipt verify, or a valid one fail, is a vulnerability even if
no server is involved.

## Supported versions

GRP is in beta; only the latest published version of each package
receives fixes.
