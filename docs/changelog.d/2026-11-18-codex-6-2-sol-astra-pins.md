## 2026-11-18 - Codex Sol and Astra pins move to 6.2

Mason asked to use the new 6.2 models. Probed on `codex-cli` 0.166.0 beside a bogus control: `gpt-6.2-sol` and `gpt-6.2-astra` answer; `gpt-6.2-luna` is refused, so Luna stays `gpt-6-luna`.

- **Sol:** the ship-gate proof (`write-codex-push-proof.mjs`), every guard that checks it (push, merge, migration apply and landing, Sol accept, the Codex production guard), the review/build/hunt scripts, skills, commands and live docs now use `gpt-6.2-sol`. A proof minted on `gpt-6-sol` no longer counts; a test proves it is refused.
- **Astra:** plan and architecture reviews (`plan-contract`, the model-tuning table) use `gpt-6.2-astra`.
- Old plans, audits and decision entries keep the model that actually ran.

Rollout: open PRs holding a `gpt-6-sol` proof need a fresh Sol run once this is on the guard checkout. This PR changes the gate model, so it cannot satisfy its own new gate; Mason or Taha merges it by hand (`docs/reference/codex-model-tuning.md`).
