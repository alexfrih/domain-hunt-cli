# domain-hunt

Is anyone searching for this, and is the .com free?

Keywords in. Per keyword out: the exact-match .com (free, taken with its dates, or dropping),
the monthly search volume, the cost per click and the trend. Free sources only.

    $ domain-hunt --seed "sourdough bread"
    keyword                       .com    vol/mo          cpc   trend
    sour bread starter            FREE   450,000   $0.02-0.46    -15%
    active sourdough starter      FREE   110,000   $0.04-0.47    -11%
    whole grain sourdough bread   FREE    74,000   $0.18-1.29    -16%
    sourdough bread near me       FREE    40,500   $0.09-1.29    +41%
    sourdough bread starter kit   FREE    40,500   $0.25-0.93    -18%
    ...
    967 Keyword Planner ideas, 254 typed in Google now, 512 short .com checked, 421 free.

    $ domain-hunt "wow guilds" "diablo 4 builds"
    keyword           .com                              vol/mo           cpc   trend
    diablo 4 builds   taken 2023-02-26 to 2027-02-26   110,000    $0.22-1.99    +27%
    wow guilds        taken 2026-02-08 to 2028-02-08     8,100   $1.09-21.30    +68%

## Install

    git clone https://github.com/alexfrih/domain-hunt-cli && cd domain-hunt-cli
    ln -sfn "$PWD/domain-hunt.ts" ~/.local/bin/domain-hunt

Needs [Bun](https://bun.sh). One file, no dependency. Linux and macOS.

## Use

    domain-hunt "wow guilds" "diablo 4 builds"   # keywords, each checked as its .com
    domain-hunt -f keywords.txt                  # one per line, # comments; stdin works too
    domain-hunt example.dev "pain au levain=painaulevain.fr"   # any TLD; name=domain sets the keyword
    domain-hunt --seed "wow forever"             # ideas around a theme, only those whose .com is free
    domain-hunt --site example.fr                # the same from what a site's pages talk about, in its country
    domain-hunt ... --json

Rows sort by volume when the Google Ads columns are on, by trend otherwise.

## Where the numbers come from

- `.com`: Verisign RDAP, no key. `FREE`, `taken <registered> to <expiry>`, or `dropping`
  (redemption or pending delete: a drop to catch). Other TLDs go through the IANA RDAP list.
- `trend`: Google Trends, worldwide, no key. The last 4 full weeks against the 12-month
  average. Throttling is retried once, then reported.
- `vol/mo`, `cpc`: Google Ads API v25, Keyword Planner: average monthly searches and the
  top-of-page bid range (average CPC too in `--json`). A country domain (.fr, .de, ...) is
  measured in its country. Without ad spend Google may round the volume.
- `--seed` and `--site` also read Google Autocomplete. `typed` in the volume column: Google
  suggests the query now and has no volume for it yet.

`FREE` is what the registry answered at that second, not a reservation.

## Google Ads setup, once

`.com` and trend need nothing. Volume, CPC, `--seed` and `--site` need your own Google Ads
API access. It costs nothing.

1. A Google Cloud project with the Google Ads API enabled and an OAuth client of type
   Desktop app. On that project, complete brand verification, then request Basic access on
   the Google Ads API Overview page (`console.cloud.google.com/google/ads-apis/overview`).
   Explorer access does not include Keyword Planner. The tool sends no developer token: the
   access belongs to the project.
2. A Google Ads **manager** account on the same Google account
   (`ads.google.com/home/tools/manager-accounts`). It answers Keyword Planner directly. A
   regular account stays `CUSTOMER_NOT_ENABLED` until its first-campaign setup is finished.
3. The OAuth client, in `~/.config/domain-hunt/google-ads.env` (`chmod 600`):

       GOOGLE_ADS_CLIENT_ID=...
       GOOGLE_ADS_CLIENT_SECRET=...

4. `domain-hunt auth`: browser sign-in. It writes `GOOGLE_ADS_REFRESH_TOKEN` to that file,
   and `GOOGLE_ADS_CUSTOMER_ID` when the sign-in reaches exactly one Ads account.

`DOMAIN_HUNT_ENV` names another file. `GOOGLE_ADS_*` variables in the environment win over
the file.

## What leaves the machine, what stays

Your keywords go to Google (Ads, Trends, Autocomplete) and the domain names to the
registries. Nothing else. Each run appends one line to `~/.local/state/domain-hunt/runs.jsonl`:
the time and the number of keywords, never the keywords.

## For an AI agent

`SKILL.md` beside this file is the short version an agent reads: give it a theme in the
conversation, it runs the hunt and answers with a shortlist.

MIT.
