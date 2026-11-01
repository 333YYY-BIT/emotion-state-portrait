# emotion-state-portrait

**Emotional continuity for LLM characters** — mood, energy state, and per-user portraits.

Most AI characters have one-off emotions: warm in one message, blank in the next, forgetting who they are talking to. This engine gives a character three persistent layers:

- **Mood** — event-triggered emotions (Lv1–4, up to 3 stacked, decaying over time), each carrying a "how to speak" prompt fragment.
- **State** — a spirit meter (0–100). Mood swings, deep thinking and heavy empathy drain it; calm chat restores it. The state word (bright / mildly tired / drowsy…) colors every reply.
- **Portrait** — per-user profile (familiarity, bond, likes, sensitivities, emotional tendencies). **The same sentence triggers different emotions for different people**, and it stacks with the AI's personality traits.

The LLM does the perceiving; the engine does the remembering, stacking, decaying and state physics. Everything is configurable; it is platform-agnostic.

## Quick start (file mode, any AI)

1. Copy this folder. Set `llm.api` / `llm.model` in `emotion/config.json`, and `integration.source: "file"`.
2. Append each incoming message as a JSON line to `emotion/inbox.jsonl` (`{user, text, t, role}`).
3. Run `node qq-emotion.mjs update` every 15 minutes (cron / scheduler).
4. Before each reply, read `mood.txt` and put it into the system prompt:
   `你现在的状态：心情：触动Lv2（被一句话轻轻打动）·感激Lv1；状态：微微疲惫（精神62）`
5. Optional panel: `node qq-emotion-ui.mjs` → http://127.0.0.1:5191

See [README.md](README.md) (Chinese, full guide) and [docs/设计.md](docs/设计.md) for the model and formulas.

## License

MIT — see [LICENSE](LICENSE).
