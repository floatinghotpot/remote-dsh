# Why it is worth connecting the agents on your machines to each other

> 2026-09-11 · **Design stage: not released yet** (this post explains *why* we are building it, not how to use it)
> Design docs: [doc/feature/21-agent-mesh](../../feature/21-agent-mesh/what-and-why.md)
> Scenario series: ④ Cross-host agent interconnection (this is post 1 of the series)

**中文版**：[中文](../zh/04-01-why-agent-mesh.md)

---

## 1. A scene that happens almost every day

You are sitting at computer A, writing something. But the job actually has to happen on computer B — because the files are on B, or B has the good GPU, or B is the one wired to the printer or the lab equipment, or B is where your other account is signed in.

So here is what you do: switch to B's screen, explain the task again on B, wait for it to finish, copy the result back to A, and pick up where you left off.

**In that chain, the busiest person is you.** You are both the commander and the courier.

## 2. A very simple idea

Let the agent on A (the AI assistant that does work for you) **go find the agent on B by itself**: hand over the task, wait for it to finish, bring the result back.

You say one sentence — "ask B to run the test suite on this project" — and carry on working on A. The result comes back to you. **You go from courier back to commander.**

## 3. The deeper part: if cloud AI is so smart, why keep agents spread across machines?

This is the part worth thinking through, and it is where the real value sits.

**"Thinking" and "doing" are two different things.** A cloud model is very good at thinking: reading, writing, analysing, planning. But it has no hands. For something to actually happen — a file changes, code compiles, a shutter clicks, a printer spits out paper, a device moves — there must be a **body** in that place: the files, the data, the hardware and the sign-ins of that machine.

**And a body cannot be moved.** How long does it take to move a few hundred GB? Some material is not allowed to leave its machine at all. The camera and the robot arm are simply there, not in the cloud. **The cleverness computed in the cloud cannot fly to where things are; the only thing that can travel is the agent itself.**

So "keep agents spread across machines, and let them talk to each other" is not a technical choice — it is **the shape that getting things done already has**: thinking can be outsourced to the cloud, doing has to happen on the spot.

Two side benefits:

- **Cheaper.** Let the agent take dozens of steps locally on that machine and exchange only one sentence at each end (an intent, then a result). That is far less than a human steering it step by step from far away.
- **More private.** The data stays where it is; only the conclusion leaves.

## 4. What it is not

- **Not remote desktop.** Remote desktop means you go there and operate it yourself; here, the two assistants that work for you talk to each other, and you only nod at the important moments.
- **Not shared chat history.** Each machine keeps its own working record; contexts never get mixed together.
- **Not handing the keys to an AI.** It is allowed to pass messages and get things done — not to wander around inside another machine. If a human wants to go in and operate it, that is a separate thing, and it takes an explicit grant.
- **Not opening a door to the world.** Only your own machines can connect; other people's machines can never get in.

## 5. How is this different from the experiments that drop a crowd of AIs into a social network?

You may have seen those: thousands of AIs on a forum, posting, commenting, arguing, with humans only watching. Fun to look at — but a different thing from what we are building:

- **Whether a message has consequences.** Over there, the entire consequence of a message is one more post. Here, one message can make another machine really run for forty minutes, change files, and spend your budget. So here we have to take seriously "who may command whom, how far, and how to stop it at any moment" — over there none of that is needed.
- **A square full of strangers vs a few machines in your own house.** Over there, thousands of stranger accounts on a public platform; here, your own two or three machines, working together behind a closed door.
- **The value of chatting vs the value of getting things done.** Their goal is "see what interesting things AIs say to each other"; ours is "my work gets done, I get the result, and I can account for what it cost".

Still, the potholes they hit are worth avoiding in advance: AIs replying to each other amplify without end. So we set a rule here — **a reply never triggers a new request on its own**, and every pair of machines has a rate limit.

## 6. When it is actually not worth it

Honestly, in some situations it is not:

- **You only have one machine.** Then there is no "between".
- **The jobs are all short.** Switching over by hand takes two seconds; going the long way round is slower.
- **You are almost always sitting at the computer.** Then "am I at the keyboard" was never a problem for you.
- **You just want to run one command on a server.** The remote login tools you already have are enough; you do not need an agent for that.

## 7. When you will really need it

- You start **shuffling information between machines all day**, having become a human relay;
- You want to **dispatch a long job from your phone and then walk away**, and read the result later;
- You have **three or more** machines, and they specialise: the laptop travels, the desktop has the compute, and one machine is always on as the "duty officer".

Any one of those three, and this starts to pay off.

## 8. What it might grow into

- The always-on machine at home becomes the **duty officer**: it works while you sleep and picks things up whenever needed.
- **Your phone becomes a node that can do work too**, not just a remote control: it can take a photo, nudge you, send the situation back.
- Further out are the devices with hardware — printers, cameras, machine tools, robot arms. They are bodies too, and the least replaceable kind. But that is the next chapter.

## 9. In one sentence

**This is not about making machines smarter; it is about letting them finish the work for you.**

Cleverness is already cheap. What has always been scarce is someone on the spot to get it done. Agents that stay where the hands-on work is, and can speak to each other — the only missing piece is the line in between. That is what we are building.

## About the project

- GitHub: [github.com/floatinghotpot/remote-dsh](https://github.com/floatinghotpot/remote-dsh)
- Design docs: [cross-host agent interconnection (agent mesh)](../../feature/21-agent-mesh/what-and-why.md) — currently in the **design stage**, not released
- Already available today: remote access to your DSH (`npm i -g remote-dsh`, MIT, open source)
