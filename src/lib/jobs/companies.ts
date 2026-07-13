import type { Source } from "./ats";

/**
 * The boards to pull from. `slug` is the company handle in the board URL:
 *   greenhouse → boards.greenhouse.io/<slug>
 *   lever      → jobs.lever.co/<slug>
 * Deliberately a VERTICAL MIX — early users are diverse (lawyers, designers,
 * doctors, engineers, PMs, remote side-hustlers), so the pool must be too.
 * All slugs live-probed 2026-07-07.
 */
export const COMPANIES: { source: Source; slug: string }[] = [
  // tech / AI
  { source: "greenhouse", slug: "anthropic" },
  { source: "greenhouse", slug: "vercel" },
  { source: "lever", slug: "mistral" },
  { source: "greenhouse", slug: "stripe" },
  // design & product
  { source: "greenhouse", slug: "figma" },
  { source: "greenhouse", slug: "webflow" },
  { source: "greenhouse", slug: "airtable" },
  { source: "greenhouse", slug: "asana" },
  { source: "greenhouse", slug: "duolingo" },
  // legal (legal-tech hires counsel, legal ops, paralegals — not just devs)
  { source: "greenhouse", slug: "everlaw" },
  // health (clinical + ops + tech; onemedical is heavy on actual clinicians)
  { source: "greenhouse", slug: "doximity" },
  { source: "greenhouse", slug: "zocdoc" },
  { source: "greenhouse", slug: "onemedical" },
  // finance & quant
  { source: "greenhouse", slug: "point72" },
  { source: "greenhouse", slug: "janestreet" },
  // marketing / content / education (probed live 2026-07-09)
  { source: "greenhouse", slug: "sproutsocial" },
  { source: "greenhouse", slug: "hootsuite" },
  { source: "greenhouse", slug: "coursera" },
  { source: "greenhouse", slug: "outschool" },
  { source: "greenhouse", slug: "klaviyo" },
  { source: "greenhouse", slug: "braze" },
  { source: "greenhouse", slug: "intercom" },
  { source: "greenhouse", slug: "typeform" },
  { source: "greenhouse", slug: "contentful" },
  { source: "greenhouse", slug: "calendly" },
  { source: "lever", slug: "palantir" },
  // remote-first (the side-hustle / work-from-anywhere pool)
  { source: "greenhouse", slug: "gitlab" },
  { source: "greenhouse", slug: "remotecom" },
  // india (many Indian firms use Darwinbox/Naukri, not GH/Lever — the bookmark
  // feature covers those; this is what's reachable via public JSON)
  { source: "greenhouse", slug: "phonepe" },
  { source: "greenhouse", slug: "groww" },
  { source: "greenhouse", slug: "postman" },
  { source: "lever", slug: "meesho" },
  { source: "greenhouse", slug: "sigmoid" },
  // more India-market boards — probe-tolerant: a bad slug just skips (the fetch
  // loop catches per-board 404s). Run a fetch and prune whatever doesn't resolve.
  { source: "lever", slug: "razorpay" },
  { source: "lever", slug: "cred" },
  { source: "greenhouse", slug: "browserstack" },
  { source: "greenhouse", slug: "hasura" },
  { source: "greenhouse", slug: "chargebee" },
  { source: "greenhouse", slug: "innovaccer" },
  { source: "greenhouse", slug: "mindtickle" },
  { source: "greenhouse", slug: "whatfix" },
  { source: "lever", slug: "clevertap" },
  { source: "lever", slug: "juspay" },
  // london / uk
  { source: "greenhouse", slug: "monzo" },
  { source: "greenhouse", slug: "gocardless" },
  // VC portfolio aggregators — hundreds of startups per board, real company
  // name carried per job (a16z: ~15k jobs across ~800 companies)
  { source: "consider", slug: "andreessen-horowitz" },
];
