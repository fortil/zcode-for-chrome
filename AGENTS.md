# Repo conventions

- This repository is (or will be) public, and everything in it — code,
  comments, commits, docs — is in English.
- Never commit internal development-process artifacts: plans, briefs,
  execution reports, work reviews, vault knowledge notes
  (`docs/notas-vault/`), or anything else from `/tasky` or agent workflows.
  Those live outside the repo (local `.tasky/historial/`, or the user's
  Obsidian vault) and are covered by `.gitignore`.
- Before every push, audit `git ls-files` and `git log --all -p` for user
  paths (`/Users/`), tokens, secrets, or personal emails.
