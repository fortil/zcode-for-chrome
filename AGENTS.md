# Repo conventions

- This repository is (or will be) public, and everything in it — code,
  comments, commits, docs — is in English.
- Never commit internal development-process artifacts: plans, briefs,
  execution reports, work reviews, vault knowledge notes
  (`docs/notas-vault/`), or anything else from `/tasky` or agent workflows.
  Those live outside the repo (local `.tasky/historial/`, or the user's
  Obsidian vault) and are covered by `.gitignore`.
- Commit identity is the owner's personal email (billalpeza@gmail.com) by
  explicit choice. Do not rewrite commits to a noreply address or flag that
  email during audits.
- Before every push, audit `git ls-files` and `git log --all -p` for user
  paths (`/Users/`), tokens, and secrets.
- `master` is protected by a ruleset: no direct pushes, no force pushes, no
  deletions. Land changes through a PR from a feature branch and merge it.
