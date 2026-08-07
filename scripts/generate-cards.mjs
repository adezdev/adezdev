#!/usr/bin/env node
/**
 * Renders the profile cards under `profile/` from live GitHub data.
 *
 * Run by `.github/workflows/profile-cards.yml` on a daily schedule. The output
 * is committed, so nothing on the profile is fetched from a third-party host at
 * render time — the cards are files in this repository, served by GitHub.
 *
 * Constraints worth knowing before editing the SVG:
 *
 *   - **No `<style>` blocks.** GitHub sanitises SVGs served from a repository,
 *     and a stylesheet is not guaranteed to survive. Every visual property here
 *     is a presentation attribute on the element itself.
 *   - **No external fonts, scripts, or animation.** The card is loaded as an
 *     image, so it cannot pull anything, and SMIL/CSS animation is stripped.
 *     Font resolution happens client-side, so only generic families are safe.
 *   - **Two variants per card.** GitHub picks between them with
 *     `prefers-color-scheme`, so light mode is not an afterthought.
 *
 * Zero dependencies on purpose: `fetch` is built into Node 18+, and a profile
 * card is not worth a supply chain.
 */

import { mkdir, writeFile } from 'node:fs/promises';

const LOGIN = process.env.PROFILE_LOGIN ?? 'adezdev';
const TOKEN = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
const OUT = 'profile';

/**
 * Public repositories only, unless explicitly opted out of.
 *
 * This defaults to safe rather than to complete, and the reason is not
 * hypothetical. A token with `repo` scope returns language byte counts for
 * *every* repository it can see, so generating with one silently publishes the
 * language mix of private work — a private Slint project shows up as a `SLINT`
 * row on a public card. Nothing names the repository, but "this person has an
 * unreleased Slint project" is inferred from the profile, which is not what a
 * stats card is for.
 *
 * Set `INCLUDE_PRIVATE=true` to opt in. Doing so also needs a PAT with `repo`
 * scope, since the default Actions token cannot see private repositories at
 * all — with `GITHUB_TOKEN` the flag is accepted and changes nothing.
 */
const INCLUDE_PRIVATE = process.env.INCLUDE_PRIVATE === 'true';

if (!TOKEN) {
  console.error('error: set GH_TOKEN or GITHUB_TOKEN');
  process.exit(1);
}

// ── data ────────────────────────────────────────────────────────────────────

const QUERY = `
query($login: String!, $privacy: RepositoryPrivacy) {
  user(login: $login) {
    login
    name
    followers { totalCount }
    contributionsCollection {
      totalCommitContributions
      totalPullRequestContributions
      totalIssueContributions
      restrictedContributionsCount
    }
    repositories(first: 100, ownerAffiliations: OWNER, isFork: false, privacy: $privacy) {
      totalCount
      nodes {
        stargazerCount
        languages(first: 12, orderBy: { field: SIZE, direction: DESC }) {
          edges { size node { name color } }
        }
      }
    }
  }
}`;

async function fetchStats() {
  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: {
      Authorization: `bearer ${TOKEN}`,
      'Content-Type': 'application/json',
      'User-Agent': `${LOGIN}-profile-cards`,
    },
    body: JSON.stringify({
      query: QUERY,
      // A null `privacy` means 'no filter'; PUBLIC restricts it.
      variables: { login: LOGIN, privacy: INCLUDE_PRIVATE ? null : 'PUBLIC' },
    }),
  });

  if (!res.ok) throw new Error(`GitHub API ${res.status}: ${await res.text()}`);
  const body = await res.json();
  // GraphQL reports failures in a 200 response, so this check is not optional.
  if (body.errors) throw new Error(`GraphQL: ${JSON.stringify(body.errors)}`);

  const u = body.data.user;
  const repos = u.repositories.nodes;
  const c = u.contributionsCollection;

  const bytes = new Map();
  for (const repo of repos) {
    for (const { size, node } of repo.languages.edges) {
      const prev = bytes.get(node.name);
      bytes.set(node.name, {
        size: (prev?.size ?? 0) + size,
        color: node.color ?? '#8b949e',
      });
    }
  }
  const total = [...bytes.values()].reduce((a, b) => a + b.size, 0) || 1;
  const languages = [...bytes.entries()]
    .map(([name, v]) => ({ name, color: v.color, pct: (v.size / total) * 100 }))
    .sort((a, b) => b.pct - a.pct);

  return {
    login: u.login,
    repos: u.repositories.totalCount,
    stars: repos.reduce((a, r) => a + r.stargazerCount, 0),
    followers: u.followers.totalCount,
    // `restrictedContributionsCount` is commit activity in repositories the
    // viewer cannot see. Counting it publishes a number derived from private
    // work, so it is included only under the same opt-in as everything else.
    commits:
      c.totalCommitContributions +
      (INCLUDE_PRIVATE ? c.restrictedContributionsCount : 0),
    prs: c.totalPullRequestContributions,
    issues: c.totalIssueContributions,
    languages,
    synced: new Date().toISOString().slice(0, 10),
  };
}

// ── theme ───────────────────────────────────────────────────────────────────

/**
 * Dark is the design; light is a faithful translation of it rather than a
 * separate idea. Same geometry, same accent hue, values inverted and the accent
 * darkened until it holds contrast on a pale panel.
 */
const THEMES = {
  dark: {
    bg0: '#04070b',
    bg1: '#0a1119',
    grid: '#0e1b26',
    gridOpacity: '0.55',
    edge: '#14303e',
    accent: '#00d5ff',
    accentDim: '#0a6f8a',
    label: '#4b6878',
    value: '#dce9f2',
    muted: '#3d5566',
    track: '#101d27',
  },
  light: {
    bg0: '#f4f7f9',
    bg1: '#e7edf1',
    grid: '#d8e2e9',
    gridOpacity: '0.9',
    edge: '#b6c6d1',
    accent: '#0089a8',
    accentDim: '#7fb3c2',
    label: '#5d7484',
    value: '#0a1a24',
    muted: '#8ea3b0',
    track: '#d5dfe6',
  },
};

const W = 380;
const H = 200;
const PAD = 22;
const MONO = "ui-monospace,SFMono-Regular,Menlo,Consolas,'Liberation Mono',monospace";

// ── svg helpers ─────────────────────────────────────────────────────────────

const pad2 = (n) => String(n).padStart(2, '0');

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function text(x, y, s, { fill, size = 9, weight = 400, anchor = 'start', spacing = 0, opacity }) {
  const a = [
    `x="${x}"`,
    `y="${y}"`,
    `fill="${fill}"`,
    `font-family="${MONO}"`,
    `font-size="${size}"`,
    `font-weight="${weight}"`,
  ];
  if (anchor !== 'start') a.push(`text-anchor="${anchor}"`);
  if (spacing) a.push(`letter-spacing="${spacing}"`);
  if (opacity) a.push(`opacity="${opacity}"`);
  return `<text ${a.join(' ')}>${esc(s)}</text>`;
}

/** Chamfered panel: top-left and bottom-right cut. Reads as a HUD plate. */
function panel(t) {
  const c = 16;
  const d = `M ${c} 0 L ${W} 0 L ${W} ${H - c} L ${W - c} ${H} L 0 ${H} L 0 ${c} Z`;
  return `
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="${t.bg1}"/>
      <stop offset="100%" stop-color="${t.bg0}"/>
    </linearGradient>
    <linearGradient id="rule" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="${t.accent}" stop-opacity="0.85"/>
      <stop offset="60%" stop-color="${t.accent}" stop-opacity="0.12"/>
      <stop offset="100%" stop-color="${t.accent}" stop-opacity="0"/>
    </linearGradient>
    <pattern id="grid" width="8" height="8" patternUnits="userSpaceOnUse">
      <path d="M 8 0 L 0 0 0 8" fill="none" stroke="${t.grid}" stroke-width="0.5"/>
    </pattern>
    <clipPath id="plate"><path d="${d}"/></clipPath>
  </defs>
  <path d="${d}" fill="url(#bg)"/>
  <rect width="${W}" height="${H}" fill="url(#grid)" opacity="${t.gridOpacity}" clip-path="url(#plate)"/>
  <path d="${d}" fill="none" stroke="${t.edge}" stroke-width="1"/>
  <path d="M 0 ${c} L ${c} 0" stroke="${t.accent}" stroke-width="1.5" fill="none"/>
  <rect x="0" y="${c + 6}" width="1.5" height="26" fill="${t.accent}" opacity="0.7"/>
  <rect x="${W - 34}" y="${H - 1.5}" width="34" height="1.5" fill="${t.accent}" opacity="0.5"/>`;
}

/** Small stacked square, used as a status glyph in the header. */
function pips(x, y, on, t) {
  let s = '';
  for (let i = 0; i < 4; i++) {
    s += `<rect x="${x + i * 6}" y="${y}" width="4" height="4" fill="${
      i < on ? t.accent : t.muted
    }" opacity="${i < on ? 0.95 : 0.5}"/>`;
  }
  return s;
}

function header(title, badge, t) {
  return `
  ${text(PAD, 26, title, { fill: t.accent, size: 8.5, weight: 700, spacing: 2.4 })}
  ${text(W - PAD, 26, badge, { fill: t.label, size: 8.5, spacing: 1.6, anchor: 'end' })}
  <rect x="${PAD}" y="34" width="${W - PAD * 2}" height="1" fill="url(#rule)"/>`;
}

function footer(left, t, on = 3) {
  return `
  <rect x="${PAD}" y="${H - 34}" width="${W - PAD * 2}" height="1" fill="${t.edge}" opacity="0.8"/>
  ${text(PAD, H - 18, left, { fill: t.muted, size: 7.5, spacing: 1.2 })}
  ${pips(W - PAD - 22, H - 24, on, t)}`;
}

const svg = (body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img">${body}\n</svg>\n`;

// ── cards ───────────────────────────────────────────────────────────────────

function statsCard(d, t) {
  const pad = (n) => String(n).padStart(2, '0');
  const rows = [
    [
      ['REPOSITORIES', pad(d.repos)],
      ['STARS', pad(d.stars)],
    ],
    [
      ['COMMITS', pad(d.commits)],
      ['FOLLOWERS', pad(d.followers)],
    ],
    [
      ['PULL REQUESTS', pad(d.prs)],
      ['ISSUES', pad(d.issues)],
    ],
  ];

  let body = panel(t) + header('OPERATOR', '// LINK ACTIVE', t);
  body += text(PAD, 58, d.login.toUpperCase(), {
    fill: t.value,
    size: 19,
    weight: 700,
    spacing: 1.5,
  });

  const colX = [PAD, PAD + 176];
  let y = 88;
  for (const row of rows) {
    row.forEach(([label, value], i) => {
      const x = colX[i];
      body += `<rect x="${x}" y="${y - 7}" width="2" height="8" fill="${t.accentDim}"/>`;
      body += text(x + 8, y, label, { fill: t.label, size: 8, spacing: 1 });
      body += text(x + 158, y, value, {
        fill: t.value,
        size: 12,
        weight: 700,
        anchor: 'end',
      });
    });
    y += 24;
  }

  return svg(body + footer(`SYNC ${d.synced}`, t));
}

function langsCard(d, t) {
  const shown = d.languages.slice(0, 6);
  let body = panel(t) + header('LANGUAGE INDEX', `// ${pad2(d.languages.length)} DETECTED`, t);

  // Stacked distribution bar. Segments are separated by a 1px gap in the panel
  // colour so adjacent languages stay distinguishable at any size.
  const barX = PAD;
  const barY = 50;
  const barW = W - PAD * 2;
  body += `<rect x="${barX}" y="${barY}" width="${barW}" height="9" fill="${t.track}"/>`;
  let cursor = barX;
  for (const l of shown) {
    const w = Math.max((l.pct / 100) * barW, 1.5);
    body += `<rect x="${cursor.toFixed(2)}" y="${barY}" width="${w.toFixed(2)}" height="9" fill="${l.color}"/>`;
    cursor += w;
  }
  body += `<rect x="${barX}" y="${barY}" width="${barW}" height="9" fill="none" stroke="${t.edge}" stroke-width="0.75"/>`;

  // Legend, two columns.
  const colX = [PAD, PAD + 176];
  shown.forEach((l, i) => {
    const x = colX[i % 2];
    const y = 84 + Math.floor(i / 2) * 22;
    body += `<rect x="${x}" y="${y - 6}" width="6" height="6" fill="${l.color}"/>`;
    body += text(x + 12, y, l.name.toUpperCase().slice(0, 12), {
      fill: t.value,
      size: 8.5,
      spacing: 0.6,
    });
    body += text(x + 158, y, `${l.pct.toFixed(2)}%`, {
      fill: t.label,
      size: 8.5,
      anchor: 'end',
    });
  });

  return svg(body + footer(`SYNC ${d.synced}`, t, 4));
}

// ── main ────────────────────────────────────────────────────────────────────

const data = await fetchStats();
await mkdir(OUT, { recursive: true });

for (const [name, t] of Object.entries(THEMES)) {
  await writeFile(`${OUT}/stats-${name}.svg`, statsCard(data, t));
  await writeFile(`${OUT}/langs-${name}.svg`, langsCard(data, t));
}

console.log(
  `wrote 4 cards — ${data.repos} repos, ${data.commits} commits, ` +
    `${data.stars} stars, ${data.languages.length} languages ` +
    `(${INCLUDE_PRIVATE ? 'public + private' : 'public only'})`
);
