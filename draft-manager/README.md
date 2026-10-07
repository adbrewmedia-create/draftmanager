# Draft Manager

Single-player manager-mode prototype. One static `index.html`, no build step, no dependencies.

## Run locally

    npx serve .

Then open the URL it prints. (Opening `index.html` directly also works.)

## Deploy to Vercel

**Option A: GitHub (recommended, auto-deploys on every push)**

1. Create a new GitHub repo and push this folder to it.
2. In Vercel: Add New > Project > import the repo.
3. Framework Preset: **Other**. Leave Build Command and Output Directory empty. Deploy.

**Option B: CLI**

    npm i -g vercel
    vercel          # preview deploy
    vercel --prod   # production deploy

`vercel.json` only adds a few headers and clean URLs; the site works with zero config.

## Notes

- The page is set to `noindex` so the prototype is not picked up by search engines. Remove the robots meta tag in `index.html` when you go public.
- Everything is client-side. The only thing stored is your best league score, in `localStorage`.
- Placeholders to replace before real players: the invite link (`draftmanager.example/join/...`), the simulated friends and lobby, and the 60-second reward timer (`REWARD_MS`, should be 24h).
- Players are fictional. Swap `genSquad()` for a real or licensed data source when you are ready.
