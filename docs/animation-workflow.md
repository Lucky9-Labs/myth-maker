# Repeatable animation work in Myth Maker

These repo-local skills capture the successful Strokah workflow and the lessons that make the next effort faster. They are ordinary skill folders, not an installed MCP plugin or a personal marketplace change.

| Start here | Use for |
| --- | --- |
| [mythmaker-animation](../.agents/skills/mythmaker-animation/SKILL.md) | Scope, visual direction, iteration, checkpointing and review |
| [mechanical-rig-motion](../.agents/skills/mechanical-rig-motion/SKILL.md) | Mech anatomy, neutral binding, grip controls, foot contact and motion fidelity |
| [animation-runtime-shipping](../.agents/skills/animation-runtime-shipping/SKILL.md) | Actual player integration, normal controls, evidence, asset hydration and shipping |

Example requests:

- “Use $mythmaker-animation to create a movement set for this model. Establish a reviewable walk before sprint and dash.”
- “Use $mechanical-rig-motion to fix the floating foregrip and knee twist, preserving the accepted walk.”
- “Use $animation-runtime-shipping to bring this accepted set onto the controllable actor and verify its real bindings.”

If the current session has not discovered the new skills, attach the linked `SKILL.md` directly or start a new task in this repository. These files do not change an already-running task's tool capabilities.

The [Strokah case study](../.agents/skills/mythmaker-animation/references/strokah-case-study.md) explains the actual user feedback and superseded experiments. The [run-record template](../.agents/skills/mythmaker-animation/references/run-record.md) keeps future efforts resumable without rereading a long chat. The [runtime map](../.agents/skills/animation-runtime-shipping/references/runtime-reference.md) locates the existing preview and Unity conversion seams.

Success means the requested motion is recognizable and accepted, mechanical constraints hold, the intended controls produce it in the target runtime, and—when shipping is requested—the artifact is reproducible and the merge is verified. Preview-only tasks stop at preview acceptance; they do not silently acquire a game-shipping scope.
