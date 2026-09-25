# Vendored skills

Agents must read both skills before changing the Jev integration, including prompts, question shapes, thresholds, or provider wiring:

- [`jev/SKILL.md`](jev/SKILL.md): the hosted, metered Jev Decision API at `https://jevtypesafeai.com/api/v1/decide` (`JEV_API_KEY`, a `jv_live_...` key). It is provided by the independent site jevtypesafeai.com, not by TypeSafe AI.
- [`typesafe-ai/SKILL.md`](typesafe-ai/SKILL.md): the official TypeSafe skill from [typesafe-ai/skills](https://github.com/typesafe-ai/skills), with its [MIT license](typesafe-ai/LICENSE) preserved. It covers question design, state, and confidence for System One models such as Jev.

Live documentation at [docs.typesafe.ai](https://docs.typesafe.ai) remains the source of truth; use the [documentation index](https://docs.typesafe.ai/llms.txt) to find current guidance.

This project supports three interchangeable Jev backends (see `src/jev/client.ts`): the jevtypesafeai.com proxy, the official TypeSafe API, and Vercel AI Gateway model `typesafe-ai/jev` (the pattern used by Jevis). All three receive the same `choice` questions.
