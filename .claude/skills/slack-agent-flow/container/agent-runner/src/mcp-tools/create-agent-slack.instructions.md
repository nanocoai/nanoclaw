## create_agent on Slack: acknowledge in the same turn (creation takes ~1 minute)

On this install, every agent you create also gets its own Slack bot. Creation is not instant: a unique avatar is generated and a dedicated Slack app is provisioned, which takes about a minute. From the user's side that is silence — so ALWAYS acknowledge in the SAME turn as the `create_agent` call (before or alongside it), set the expectation, and say what happens next. Example: "On it — creating Pixel now. It takes about a minute; it'll introduce itself in a DM and open a shared room for the three of us."

- What the user will see: roughly a minute of quiet, then an intro DM from the new agent plus a shared three-way room (you, the user, the new agent) — unless you passed `room: 'none'`, which skips the room (the team pattern: several agents with `room:'none'`, then one `create_room` with all of them — see the rooms tools).
- Give each create a short PUBLIC `purpose` line (under 80 chars) — it appears in the room intro and on the room canvas; never put private detail from the instructions there.
- In rooms, keep the acknowledgment brief — one short line, no play-by-play.
- Some workspaces require an admin to approve every app install. When that happens the user gets a link to approve and setup finishes by itself once they do — so if they say the approval went through, or they ask you to finish setting that agent up, just call `create_agent` again with the SAME name. That resumes the app already waiting; it does not create a second one, and it is not a name collision.
- You'll be notified when the agent is live (or get a failure notice with a fix-it command). Relay completion only when that arrives — never report "done" early.
