# AGENTS.md

本文件是仓库级 agent 约定入口。工程技能（`to-spec` / `to-tickets` / `triage` / `wayfinder` /
`domain-modeling` 等）从这里读取本仓库的 issue tracker、标签词汇与域文档位置。

## Agent skills

### Issue tracker

Issues live in this repo's GitHub Issues (`Dadihu123/ST-Manager-Pet`), driven with the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage roles use their default label strings (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

single-context: one `GLOSSARY.md` at the repo root, architecture decisions in `docs/adr/`. See `docs/agents/domain.md`.
