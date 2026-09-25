# Vendored skills

Agents must read [`typesafe-ai/SKILL.md`](typesafe-ai/SKILL.md) before changing the Jev integration, including prompts, question shapes, thresholds, or Gateway wiring. The skill is vendored from [typesafe-ai/skills](https://github.com/typesafe-ai/skills) (copied from Jevis), with its [MIT license](typesafe-ai/LICENSE) preserved.

Live documentation at [docs.typesafe.ai](https://docs.typesafe.ai) remains the source of truth; use the [documentation index](https://docs.typesafe.ai/llms.txt) to find current guidance. For folder assignment, the relevant pages are [Choice](https://docs.typesafe.ai/primitives/choice.md), [Confidence](https://docs.typesafe.ai/confidence.md), and the [hierarchical classification cookbook](https://docs.typesafe.ai/cookbooks/hierarchical_classification.md).

**This project uses Vercel AI Gateway model `typesafe-ai/jev`. Never call the TypeSafe API directly from this project**, and do not route through third-party Jev proxies (a hosted proxy skill exists at jevtypesafeai.com; it is intentionally not used or vendored here). The only Jev client is `src/jev/client.ts`, which is pinned to the Gateway endpoint and authenticates with `AI_GATEWAY_API_KEY`.
