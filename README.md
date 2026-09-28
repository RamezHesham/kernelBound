# Kernelbound on Vercel

The game is a single static page (`index.html`). The class leaderboard is one serverless
function (`api/scores.js`) that stores scores in Upstash Redis. There is nothing to install
and no build step.

## Deploy

1. Put this folder in a GitHub repository (or run `npx vercel` inside it).
2. In Vercel, click **Add New > Project**, import the repository, and deploy. Leave every
   setting on its default (Framework preset: Other).
3. Open the project's **Storage** tab, click **Create Database**, choose
   **Upstash for Redis**, pick the free plan, and connect it to the project for all
   environments.
4. Go to **Deployments** and **Redeploy** the latest deployment, so the function picks up
   the new storage variables.

Open the site and check the Class leaderboard panel on the campaign map. If it says the
storage isn't connected, step 3 or 4 was missed.

## Separate boards per class

Add `?class=` to the link, for example:

- `https://your-game.vercel.app/?class=cs102a`
- `https://your-game.vercel.app/?class=cs102b`

Each class name gets its own board. The plain link uses a board called `main`.

## How students are identified

There are no accounts. Each browser gets a secret 16-character player code, shown in the
full leaderboard. A student who moves to another computer can enter their code there to keep
one spot on the board. The board keeps each student's best-ever result, so switching
computers or resetting progress never lowers it.

The server checks every score it receives: it clamps impossible values and recomputes the
score from the stats itself. Game progress still lives in each student's browser, so treat
the board as friendly competition rather than a grade.

## Resetting a board

In the Upstash console for the database, delete the keys `kb:<class>:rows` and
`kb:<class>:rank` (for example `kb:main:rows` and `kb:main:rank`).

## Free tier usage

Each open game checks the board every 30 seconds while its tab is visible, and Vercel caches
that response for 5 seconds, so a class of 100 students fits comfortably in Upstash's free
monthly command allowance.
