---
name: domain-hunt
description: Check whether anyone searches for a keyword and whether its exact-match .com is free, with the `domain-hunt` CLI (.com status, monthly search volume, cost per click, trend). Use when the user wants a domain name, asks if a domain is free, or wants name ideas around a theme or a site.
---

# domain-hunt

The user gives a theme or a few keywords in the conversation. You build the candidate list,
run `domain-hunt` and answer with a shortlist. Never ask the user to write a keyword file.
Read `README.md` beside this file before the first run: it holds the install and the Google
Ads setup.

## The usual case

    domain-hunt "wow guilds" "diablo 4 builds" --json   # these exact names
    domain-hunt --seed "wow forever" --json             # ideas around a theme, free .com only
    domain-hunt --site example.fr --json                # ideas from what a site talks about, in its country

Several `--seed` in one run widen the hunt. Any TLD works as `name=domain`.

## Rules

- Answer with the best few, each with its figures: keyword, domain, status, volume, CPC, trend.
- `FREE` is what the registry answered at that second, not a reservation. Say so.
- Never buy a domain. The user buys.
- `volume, CPC: off` in the output: the Google Ads setup is missing. Say so and report the
  .com and the trend only. `--seed` and `--site` do not run without it.
- A missing trend means Google Trends throttled the run. Report the rest; do not retry in a loop.
- `typed` in the volume column: Google suggests the query now and has no volume for it yet.
- The keywords go to Google and the domain names to the registries. Ask before running it on
  a name the user wants kept confidential.
