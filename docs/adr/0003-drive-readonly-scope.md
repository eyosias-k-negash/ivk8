# 0003. Google Drive access with `drive.readonly`

- Status: accepted (2026-10-01)

## Context
Users pick an existing folder full of backups that Ivy Wallet wrote. `drive.file` would only see files the app created or the user opened through the Picker, one file at a time. That breaks "list every backup version".

## Decision
Request `openid email https://www.googleapis.com/auth/drive.readonly` with PKCE. Every report request checks that the file's parent is the folder the user chose.

## Consequences
- The app can never write, move or delete Drive content.
- `drive.readonly` is a restricted scope. Testing mode (up to 100 listed test users) is enough for the portfolio. A public launch needs Google's verification and security assessment.
