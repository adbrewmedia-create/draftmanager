name: Fetch Premier League data

# Run it by hand: Actions tab > "Fetch Premier League data" > Run workflow.
# It downloads real squads from API-Football using the secret API_FOOTBALL_KEY
# and commits the data files to the repo. The key never appears in the code.
on:
  workflow_dispatch:
    inputs:
      from:
        description: "First season (the year it starts, e.g. 2023 = 2023/24)"
        required: true
        default: "2023"
      to:
        description: "Last season (inclusive)"
        required: true
        default: "2023"

permissions:
  contents: write

jobs:
  fetch:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: 20

      - name: Download data
        env:
          API_FOOTBALL_KEY: ${{ secrets.API_FOOTBALL_KEY }}
          FROM: ${{ inputs.from }}
          TO: ${{ inputs.to }}
        run: node tools/fetch-pl-data.mjs --from "$FROM" --to "$TO" --out data/pl

      - name: Commit data
        env:
          FROM: ${{ inputs.from }}
          TO: ${{ inputs.to }}
        run: |
          git config user.name "data-bot"
          git config user.email "data-bot@users.noreply.github.com"
          git add data/pl/*.json
          git diff --cached --quiet || git commit -m "Add Premier League data $FROM-$TO"
          git push
