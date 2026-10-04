# Third-Party Notices

Decision Lab's original application code and documentation are licensed under MIT; see [LICENSE](LICENSE). Third-party components retain their own licenses and copyright notices.

## Local inference components

These components are installed/downloaded separately. Their runtime code, base weights, and adapter weights are not bundled in this repository.

| Component | License | Upstream license |
| --- | --- | --- |
| Strands Decider Python runtime | Apache-2.0 | [Runtime LICENSE](https://github.com/strands-labs/strands-decider/blob/75c9fd32e664954cdc18481434018aa507eee8fb/LICENSE) |
| `StrandsAgents/strands-decider-2B-hobson-v19` adapter and head | Apache-2.0 | [Checkpoint LICENSE.md](https://huggingface.co/StrandsAgents/strands-decider-2B-hobson-v19/blob/main/LICENSE.md) |
| `Qwen/Qwen3.5-2B-Base` | Apache-2.0 | [Base model LICENSE](https://huggingface.co/Qwen/Qwen3.5-2B-Base/blob/main/LICENSE) |

The checkpoint's license document also describes its training-data sources and their separate terms. Decision Lab does not redistribute those training datasets. Jev is accessed through an external API; this project's MIT license does not grant rights to that service or its models.

## Runtime npm dependencies

Copies of the installed production dependency license texts are retained under [third-party-licenses/](third-party-licenses/), including upstream copyright notices.

| Package | License | Retained text |
| --- | --- | --- |
| React | MIT | [react](third-party-licenses/react.txt) |
| React DOM | MIT | [react-dom](third-party-licenses/react-dom.txt) |
| Scheduler (React DOM dependency) | MIT | [scheduler](third-party-licenses/scheduler.txt) |
| Hono | MIT | [hono](third-party-licenses/hono.txt) |
| `@hono/node-server` | MIT | [hono-node-server](third-party-licenses/hono-node-server.txt) |
| Zod | MIT | [zod](third-party-licenses/zod.txt) |
| dotenv | BSD-2-Clause | [dotenv](third-party-licenses/dotenv.txt) |

Development tools and Python dependencies retain the license files in their own distributions. `package-lock.json` records npm package versions and license identifiers; the separately managed Python environment has its own dependency lockfile.

## Repository skill

The installed TypeSafe AI skill is MIT-licensed, copyright 2026 TypeSafe AI. Its original license is preserved at [.agents/skills/typesafe-ai/LICENSE](.agents/skills/typesafe-ai/LICENSE).
