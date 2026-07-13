// src/lib/opportunities/match.ts
var s = (p) => p?.score ?? 0.5;
function scoreMatch(user, opp) {
  const qual = [
    ["seniority", s(user.seniority), s(opp.req_seniority)],
    ["leadership", s(user.leadership_inclination), s(opp.req_leadership)],
    ["technical depth", s(user.technical_depth), s(opp.req_technical_depth)],
    ["breadth", s(user.breadth), s(opp.req_breadth)]
  ].map(([label, u, r]) => ({
    key: `q_${label}`,
    label,
    user: u,
    role: r,
    weight: 1,
    // under-qual only (a 0.05 wiggle keeps a hairline shortfall free), penalised
    // SUPER-LINEARLY: a mild stretch barely dents, but a big single-axis gap is a
    // wall. deficit 0.15 → clearance ~0.88; 0.30 → ~0.56; 0.45 → ~0.15. The
    // linear version wasn't decisive enough — a salesperson (tech 0.2) still
    // cleared an entry-level eng role at ~0.85 because one 0.35 gap only cost 0.65.
    fit: 1 - Math.min(1, Math.pow(Math.max(0, r - u - 0.05) / 0.45, 1.4))
  }));
  const qualification = mean(qual.map((a) => a.fit));
  const gate = qual.reduce((g, a) => g * a.fit, 1);
  const alignPairs = [
    ["building", s(user.builder_energy), s(opp.off_building)],
    ["people leadership", s(user.people_energy), s(opp.off_people_leadership)],
    ["autonomy", s(user.autonomy_need), s(opp.off_autonomy)],
    ["impact", s(user.impact_drive), s(opp.off_impact)],
    ["risk", s(user.risk_tolerance), s(opp.off_company_risk)],
    ["growth", s(user.growth_vs_stability), s(opp.off_growth)],
    ["domain pivot", s(user.pivot_appetite), s(opp.off_domain_novelty)]
  ];
  const desireAxes = alignPairs.map(([label, u, r]) => ({
    key: `d_${label}`,
    label,
    user: u,
    role: r,
    weight: Math.abs(u - 0.5) * 2,
    // how strongly they feel
    fit: 1 - Math.abs(u - r)
    // linear — every mismatch costs what it is
  }));
  const compLevel = s(opp.off_comp_level);
  desireAxes.push({
    key: "d_comp",
    label: "compensation",
    user: s(user.comp_priority),
    role: compLevel,
    weight: s(user.comp_priority),
    fit: compLevel
    // linear shortfall, same de-compression as the other axes
  });
  const desire = weightedMean(desireAxes);
  const fit = gate * desire;
  const breakdown = [...qual, ...desireAxes];
  const scored = breakdown.filter((a) => a.weight > 0.15).map((a) => ({ a, impact: a.weight * a.fit, miss: a.weight * (1 - a.fit) }));
  const strong = scored.filter((x) => x.a.fit > 0.72).sort((x, y) => y.impact - x.impact);
  const reasons = [
    ...strong.filter((x) => x.a.key.startsWith("d_")),
    ...strong.filter((x) => x.a.key.startsWith("q_"))
  ].slice(0, 3).map((x) => phrase(x.a, true));
  const gaps = scored.filter((x) => x.miss > 0.2).sort((x, y) => y.miss - x.miss).slice(0, 3).map((x) => phrase(x.a, false));
  return { fit, gate, qualification, desire, reasons, gaps, breakdown };
}
function phrase(a, positive) {
  const L = cap(a.label);
  if (positive)
    return `${L} lines up`;
  if (a.key.startsWith("q_"))
    return `Stretch on ${a.label} \u2014 the role asks for more than you show`;
  if (a.key === "d_comp")
    return `Comp looks below where you'd want it`;
  return a.user > a.role ? `You want more ${a.label} than this offers` : `More ${a.label} here than you're after`;
}
var cap = (str) => str.charAt(0).toUpperCase() + str.slice(1);
var mean = (xs) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
function weightedMean(axes) {
  const w = axes.reduce((a, x) => a + x.weight, 0);
  return w > 0 ? axes.reduce((a, x) => a + x.weight * x.fit, 0) / w : 0.5;
}

// src/lib/opportunities/blend.ts
var BLEND_WEIGHTS = { desire: 0.35, evidence: 0.35, trajectory: 0.3 };
function blendCore(desire, evidence, trajectory, w = BLEND_WEIGHTS) {
  const parts = [[desire, w.desire]];
  if (evidence !== null)
    parts.push([evidence, w.evidence]);
  if (trajectory !== null)
    parts.push([trajectory, w.trajectory]);
  const wsum = parts.reduce((a, [, wt]) => a + wt, 0);
  return wsum > 0 ? parts.reduce((a, [x, wt]) => a + x * wt, 0) / wsum : desire;
}
var REL_DAMP_STRENGTH = 0.6;
var JUNIOR_SENIORITY = 0.55;
function relevanceDamp(userSeniority, evidence, trajectory) {
  const juniorness = Math.max(0, (JUNIOR_SENIORITY - userSeniority) / JUNIOR_SENIORITY);
  if (juniorness === 0)
    return 1;
  const relevance = Math.max(evidence ?? 0.5, trajectory ?? 0.5);
  return 1 - juniorness * REL_DAMP_STRENGTH * (1 - relevance);
}

// src/lib/opportunities/gates.ts
var DEGREES = ["phd", "md", "jd", "mba", "masters", "bachelors", "associate"];
var YEARS_WIGGLE = 2;
var MARGINAL_PENALTY = 0.88;
function parseYear(s2) {
  const m = (s2 ?? "").match(/\b(19|20)\d{2}\b/);
  return m ? Number(m[0]) : null;
}
var DEGREE_PATTERNS = [
  ["phd", /\bph\.?\s?d|doctor(ate|al)\b|\bd\.?phil\b/i],
  ["md", /\bm\.?d\.?\b|doctor of medicine|\bmbbs\b|\bdo\b.{0,20}osteopath/i],
  ["jd", /\bj\.?d\.?\b|juris doctor|\bll\.?[bm]\b|bachelor of law/i],
  ["mba", /\bm\.?b\.?a\b|master of business/i],
  ["masters", /\bmaster|\bm\.?s(c|\b)|\bm\.?tech\b|\bm\.?e(ng)?\b|\bm\.?a\b|\bm\.?com\b|\bm\.?phil\b|post.?graduate/i],
  ["bachelors", /\bbachelor|\bb\.?s(c|\b)|\bb\.?tech\b|\bb\.?e(ng)?\b|\bb\.?a\b|\bb\.?com\b|\bb\.?b\.?a\b|undergrad/i],
  ["associate", /associate('?s)? degree|\ba\.?a\.?s?\b(?=.{0,20}degree)|\bdiploma\b/i]
];
var LICENSE_PATTERNS = [
  ["cpa", /\bcpa\b|certified public accountant/i],
  ["ca", /\bchartered accountant\b|\bicai\b|\bca\b(?=.{0,25}(institute|chartered|india|final))/i],
  ["cfa", /\bcfa\b(?!.{0,20}(level\s*(i|1|ii|2)\b|candidate))|chartered financial analyst/i],
  ["frm", /\bfrm\b|financial risk manager/i],
  ["cfp", /\bcfp\b|certified financial planner/i],
  ["bar", /\bbar (admission|admitted|exam passed|council)\b|admitted to (the )?bar|state bar of/i],
  ["rn", /\bregistered nurse\b|\brn\b(?=.{0,20}(licen|registered|nurse))|nursing licen[cs]e/i],
  ["pe", /\bprofessional engineer\b|\bp\.?e\.? licen[cs]e/i],
  ["pmp", /\bpmp\b|project management professional/i]
];
function deriveCandidateQuals(input) {
  const startYears = input.experiences.map((e) => parseYear(e.startDate)).filter((y) => y !== null);
  const yearsExperience = startYears.length ? Math.max(0, (/* @__PURE__ */ new Date()).getFullYear() - Math.min(...startYears)) : null;
  const credentials = /* @__PURE__ */ new Set();
  for (const ed of input.education) {
    const d = ed.degree ?? "";
    for (const [cred, pat] of DEGREE_PATTERNS)
      if (pat.test(d))
        credentials.add(cred);
  }
  for (const cert of input.certifications ?? []) {
    const t = [cert.name, cert.issuer].filter(Boolean).join(" ");
    for (const [cred, pat] of [...LICENSE_PATTERNS, ...DEGREE_PATTERNS])
      if (pat.test(t))
        credentials.add(cred);
  }
  return { yearsExperience, credentials };
}
var SATISFIES = {
  phd: ["phd"],
  md: ["md"],
  jd: ["jd"],
  mba: ["mba"],
  masters: ["masters", "mba", "phd", "md", "jd"],
  bachelors: ["bachelors", "masters", "mba", "phd", "md", "jd"],
  associate: ["associate", "bachelors", "masters", "mba", "phd", "md", "jd"],
  cpa: ["cpa"],
  ca: ["ca"],
  cfa: ["cfa"],
  frm: ["frm"],
  cfp: ["cfp"],
  bar: ["bar"],
  rn: ["rn"],
  pe: ["pe"],
  pmp: ["pmp"]
};
var REQ_LABEL = {
  phd: "a PhD",
  md: "an MD",
  jd: "a JD/LLB",
  mba: "an MBA",
  masters: "a master's degree",
  bachelors: "a bachelor's degree",
  associate: "an associate degree",
  cpa: "a CPA",
  ca: "a CA",
  cfa: "a CFA charter",
  frm: "an FRM",
  cfp: "a CFP",
  bar: "bar admission",
  rn: "an RN license",
  pe: "a PE license",
  pmp: "a PMP"
};
var ALIASES = {
  "ph.d": "phd",
  doctorate: "phd",
  mbbs: "md",
  llb: "jd",
  llm: "jd",
  master: "masters",
  "master's": "masters",
  msc: "masters",
  bachelor: "bachelors",
  "bachelor's": "bachelors",
  bsc: "bachelors",
  "bar admission": "bar",
  "registered nurse": "rn",
  "professional engineer": "pe"
};
var INTERNSHIP = /\b(intern|internship|trainee|apprentice(ship)?|co-?op|working student|praktikum|summer analyst)\b/i;
var ENTRY_LEVEL = /\b(entry[ -]?level|junior|jr\.?|new grad(uate)?|grad(uate)? (scheme|programme|program|analyst|trainee)|early[ -]?career)\b/i;
function hardGate(role, cand) {
  const f = role.facts ?? {};
  const title = role.title ?? f.title ?? "";
  const yrs = cand.yearsExperience;
  if (yrs !== null) {
    if (INTERNSHIP.test(title) && yrs >= 3) {
      return { pass: false, reason: `an internship \u2014 you're at ${yrs} yrs` };
    }
    if (ENTRY_LEVEL.test(title) && yrs >= 8) {
      return { pass: true, marginal: { penalty: 0.6, gap: `An entry-level role \u2014 well below your ${yrs} yrs` } };
    }
  }
  const requiredCreds = (f.required_credentials ?? []).map((c) => c.toLowerCase().trim()).map((c) => c in SATISFIES ? c : ALIASES[c]).filter((c) => !!c);
  for (const req of requiredCreds) {
    if (!SATISFIES[req].some((c) => cand.credentials.has(c))) {
      return { pass: false, reason: `requires ${REQ_LABEL[req]}` };
    }
  }
  const reqYears = f.min_years_experience ?? null;
  if (reqYears !== null && cand.yearsExperience !== null) {
    const shortfall = reqYears - cand.yearsExperience;
    if (shortfall > YEARS_WIGGLE)
      return { pass: false, reason: `asks ${reqYears}+ yrs \u2014 you're at ${cand.yearsExperience}` };
    if (shortfall > 0) {
      return { pass: true, marginal: { penalty: MARGINAL_PENALTY, gap: `Asks ${reqYears}+ yrs \u2014 you're at ${cand.yearsExperience} (close enough to try)` } };
    }
  }
  return { pass: true };
}

// src/lib/skills/canon.ts
var ALIAS = {
  k8s: "kubernetes",
  postgres: "postgresql",
  golang: "go",
  "node js": "node.js",
  nodejs: "node.js",
  "next js": "next.js",
  nextjs: "next.js",
  reactjs: "react",
  "react js": "react",
  js: "javascript",
  ts: "typescript",
  cicd: "ci/cd",
  "ci cd": "ci/cd",
  "amazon web services": "aws",
  "google cloud platform": "gcp",
  "google cloud": "gcp",
  "large language models": "llms",
  llm: "llms",
  "machine learning ops": "mlops",
  "ml ops": "mlops",
  "user experience": "ux",
  "user interface": "ui",
  "a b testing": "a/b testing",
  "ab testing": "a/b testing"
};
function canonSkillKey(raw) {
  let k = String(raw ?? "").toLowerCase().replace(/\s*\/\s*/g, "/").replace(/[–—]/g, "-").replace(/\s+/g, " ").replace(/[.。]+$/g, "").trim();
  return ALIAS[k] ?? k;
}

// src/lib/format/currency.ts
var CURRENCIES = {
  USD: { symbol: "$", usd: 1 },
  EUR: { symbol: "\u20AC", usd: 1.08 },
  GBP: { symbol: "\xA3", usd: 1.27 },
  INR: { symbol: "\u20B9", usd: 1 / 85, lakhs: true },
  SGD: { symbol: "S$", usd: 0.74 },
  AED: { symbol: "AED ", usd: 0.27 },
  AUD: { symbol: "A$", usd: 0.66 },
  CAD: { symbol: "C$", usd: 0.73 },
  CHF: { symbol: "CHF ", usd: 1.12 },
  JPY: { symbol: "\xA5", usd: 1 / 155, bigUnit: true },
  CNY: { symbol: "CN\xA5", usd: 0.14 },
  SEK: { symbol: "SEK ", usd: 0.095 },
  NOK: { symbol: "NOK ", usd: 0.093 },
  DKK: { symbol: "DKK ", usd: 0.145 },
  PLN: { symbol: "z\u0142", usd: 0.25 },
  CZK: { symbol: "K\u010D", usd: 0.043 },
  RON: { symbol: "RON ", usd: 0.22 },
  BRL: { symbol: "R$", usd: 0.18 },
  MXN: { symbol: "MX$", usd: 0.055 },
  NZD: { symbol: "NZ$", usd: 0.61 },
  HKD: { symbol: "HK$", usd: 0.13 },
  KRW: { symbol: "\u20A9", usd: 1 / 1350, bigUnit: true },
  ILS: { symbol: "\u20AA", usd: 0.27 },
  ZAR: { symbol: "R", usd: 0.055 },
  IDR: { symbol: "Rp", usd: 1 / 16e3, bigUnit: true },
  MYR: { symbol: "RM", usd: 0.22 },
  THB: { symbol: "\u0E3F", usd: 0.028 },
  PHP: { symbol: "\u20B1", usd: 0.017 },
  VND: { symbol: "\u20AB", usd: 1 / 25e3, bigUnit: true },
  TRY: { symbol: "\u20BA", usd: 0.03 }
};
var CUR_ALIAS = {
  "\u20B9": "INR",
  RS: "INR",
  RUPEES: "INR",
  $: "USD",
  US$: "USD",
  "\xA3": "GBP",
  "\u20AC": "EUR",
  S$: "SGD",
  A$: "AUD",
  C$: "CAD",
  "\xA5": "JPY",
  DHS: "AED",
  DIRHAM: "AED"
};
function normCurrency(raw) {
  if (!raw)
    return null;
  const k = String(raw).trim().toUpperCase();
  if (CURRENCIES[k])
    return k;
  return CUR_ALIAS[k] ?? null;
}
function toUSD(amount, currency) {
  const iso = normCurrency(currency);
  return iso ? amount * CURRENCIES[iso].usd : null;
}
function fmtMoney(n, currency) {
  const iso = normCurrency(currency);
  const info = iso ? CURRENCIES[iso] : null;
  const sym = info?.symbol ?? "";
  if (info?.lakhs)
    return n >= 1e5 ? `${sym}${Math.round(n / 1e5)}L` : `${sym}${Math.round(n / 1e3)}k`;
  if (info?.bigUnit && n >= 1e6)
    return `${sym}${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M`;
  return n >= 1e3 ? `${sym}${Math.round(n / 1e3)}k` : `${sym}${n}`;
}

// src/lib/format/comp.ts
var INR_HINTS = /india|bengaluru|bangalore|mumbai|delhi|gurgaon|gurugram|noida|hyderabad|pune|chennai|kolkata|ahmedabad|jaipur|kochi/i;
var GBP_HINTS = /\buk\b|united kingdom|london|manchester|edinburgh|dublin/i;
var EUR_HINTS = /germany|berlin|munich|france|paris|amsterdam|netherlands|spain|madrid|barcelona|italy|milan|lisbon|portugal|brussels|belgium|zurich|switzerland|stockholm|sweden|copenhagen|denmark|helsinki|finland|oslo|norway|vienna|austria|warsaw|poland|prague|czech/i;
var USD_HINTS = /\busa?\b|united states|san francisco|new york|seattle|austin|boston|chicago|los angeles|denver|atlanta|miami|washington|portland|philadelphia|dallas|houston|phoenix|san diego|san jose|canada|toronto|vancouver/i;
function inferCurrency(location) {
  const loc = location ?? "";
  if (!loc)
    return null;
  if (INR_HINTS.test(loc))
    return "INR";
  if (GBP_HINTS.test(loc))
    return "GBP";
  if (EUR_HINTS.test(loc))
    return "EUR";
  if (/,\s*[A-Z]{2}(\s*\||$)/.test(loc) || USD_HINTS.test(loc))
    return "USD";
  return null;
}
var COUNTRY_HINTS = [
  [/india|bengaluru|bangalore|mumbai|delhi|gurgaon|gurugram|noida|hyderabad|pune|chennai|kolkata|ahmedabad|jaipur|kochi/i, "India"],
  [/\bireland\b|dublin/i, "Ireland"],
  [/\buk\b|united kingdom|england|scotland|wales|london|manchester|edinburgh|birmingham|bristol|leeds|glasgow|cambridge|oxford/i, "United Kingdom"],
  [/germany|berlin|munich|münchen|hamburg|frankfurt|cologne/i, "Germany"],
  [/france|paris|lyon|toulouse/i, "France"],
  [/netherlands|amsterdam|rotterdam|utrecht|the hague/i, "Netherlands"],
  [/spain|madrid|barcelona|valencia/i, "Spain"],
  [/\bitaly\b|milan|rome|turin/i, "Italy"],
  [/portugal|lisbon|porto/i, "Portugal"],
  [/switzerland|zurich|zürich|geneva|lausanne/i, "Switzerland"],
  [/sweden|stockholm|gothenburg/i, "Sweden"],
  [/poland|warsaw|krakow|kraków|wroclaw/i, "Poland"],
  [/singapore/i, "Singapore"],
  [/\bjapan\b|tokyo|osaka|kyoto/i, "Japan"],
  [/south korea|\bkorea\b|seoul/i, "South Korea"],
  [/australia|sydney|melbourne|brisbane|perth/i, "Australia"],
  [/new zealand|auckland|wellington/i, "New Zealand"],
  [/\buae\b|dubai|abu dhabi/i, "United Arab Emirates"],
  [/israel|tel aviv|\bhaifa\b/i, "Israel"],
  [/morocco|casablanca|rabat/i, "Morocco"],
  [/\bbrazil\b|são paulo|sao paulo|rio de janeiro/i, "Brazil"],
  [/\bmexico\b|mexico city|guadalajara/i, "Mexico"],
  [/romania|bucharest|cluj/i, "Romania"],
  [/canada|toronto|vancouver|montreal|montréal|ottawa|calgary|waterloo/i, "Canada"]
];
function inferCountry(location) {
  const loc = location ?? "";
  if (!loc)
    return null;
  for (const [re, country] of COUNTRY_HINTS)
    if (re.test(loc))
      return country;
  if (/,\s*[A-Z]{2}(\s|,|\||$)/.test(loc) || /\busa?\b|united states|san francisco|new york|seattle|austin|boston|chicago|los angeles|denver|atlanta|miami|washington|portland|philadelphia|dallas|houston|phoenix|san diego|san jose|remote - us/i.test(loc)) {
    return "United States";
  }
  return null;
}

// src/lib/geo/canon.ts
var PHRASE_ALIAS = [
  [/\bnew york city\b/g, "new york"],
  [/\bnyc\b/g, "new york"],
  [/\bbangalore\b/g, "bengaluru"],
  [/\bblr\b/g, "bengaluru"],
  [/\bbombay\b/g, "mumbai"],
  [/\bnew delhi\b/g, "delhi"],
  [/\bgurgaon\b/g, "gurugram"],
  [/\bsan fran\b/g, "san francisco"],
  [/\bsf bay area\b/g, "san francisco"],
  [/\bsf\b/g, "san francisco"],
  [/\bsfo\b/g, "san francisco"],
  [/\bla\b(?=[ ,]|$)/g, "los angeles"],
  // token-only; never inside a word
  [/\bwashington,? d\.?c\.?\b/g, "washington dc"],
  [/\bsaint\b/g, "st"],
  [/\buk\b/g, "united kingdom"],
  [/\busa?\b/g, "united states"],
  [/\buae\b/g, "united arab emirates"]
];
function canonLocationText(raw) {
  let s2 = String(raw ?? "").toLowerCase().replace(/[()|;/·•]+/g, " ").replace(/[^a-z0-9,\s.-]+/g, " ").replace(/\s+/g, " ").trim();
  for (const [re, to] of PHRASE_ALIAS)
    s2 = s2.replace(re, to);
  return s2;
}
function canonCity(raw) {
  return canonLocationText(raw).replace(/,.*$/, "").trim();
}
function cityMatch(roleLocation, prefCity) {
  if (!roleLocation)
    return false;
  const key = canonCity(prefCity);
  if (key.length < 3)
    return false;
  return canonLocationText(roleLocation).includes(key);
}
function firstCityHit(roleLocation, cities) {
  if (!cities?.length)
    return null;
  return cities.find((c) => cityMatch(roleLocation, c)) ?? null;
}

// src/lib/opportunities/rank-core.ts
var EVENT_WEIGHT = {
  applied: 1,
  up: 0.75,
  apply_click: 0.5,
  down: -0.75,
  dismiss: -0.8
};
var AXIS_PAIRS = [
  ["builder_energy", "off_building"],
  ["people_energy", "off_people_leadership"],
  ["autonomy_need", "off_autonomy"],
  ["impact_drive", "off_impact"],
  ["risk_tolerance", "off_company_risk"],
  ["growth_vs_stability", "off_growth"],
  ["pivot_appetite", "off_domain_novelty"]
];
var clamp01 = (n) => Math.min(1, Math.max(0, n));
var COS_LO = 0.41;
var COS_HI = 0.68;
function trajectoryFromCosine(cos) {
  return 0.5 + 0.5 * clamp01((cos - COS_LO) / (COS_HI - COS_LO));
}
var SIGNAL_KINDS = Object.keys(EVENT_WEIGHT);
function distillSignals(rows) {
  if (!rows.length)
    return null;
  let totalWeight = 0;
  const sums = {};
  for (const r of rows) {
    const w = EVENT_WEIGHT[r.kind] ?? 0;
    if (!w)
      continue;
    const v = r.vector ?? {};
    totalWeight += Math.abs(w);
    for (const [, roleAxis] of AXIS_PAIRS) {
      const score = v[roleAxis]?.score ?? 0.5;
      sums[roleAxis] = (sums[roleAxis] ?? 0) + w * (score - 0.5);
    }
  }
  if (totalWeight === 0)
    return null;
  const confidence = Math.min(1, totalWeight / 6);
  const deltas = {};
  for (const [userAxis, roleAxis] of AXIS_PAIRS) {
    const direction = (sums[roleAxis] ?? 0) / totalWeight;
    const d = 0.3 * direction * confidence;
    if (Math.abs(d) > 5e-3)
      deltas[userAxis] = d;
  }
  return { deltas, confidence, events: rows.length };
}
function applyDrift(vec, drift) {
  if (!drift || !Object.keys(drift.deltas).length)
    return vec;
  const out = { ...vec };
  for (const [axis, delta] of Object.entries(drift.deltas)) {
    const cur = out[axis];
    if (!cur || typeof cur.score !== "number")
      continue;
    out[axis] = { ...cur, score: clamp01(cur.score + delta) };
  }
  return out;
}
function applyQualOverrides(derived, o) {
  if (!o)
    return derived;
  let credentials = derived.credentials;
  if (o.highestDegree !== void 0) {
    credentials = new Set([...derived.credentials].filter((c) => !DEGREES.includes(c)));
    if (o.highestDegree !== "none")
      credentials.add(o.highestDegree);
  }
  return { yearsExperience: o.yearsExperience ?? derived.yearsExperience, credentials };
}
var normSkill = (s2) => canonSkillKey(String(s2 ?? ""));
function skillEvidence(mine, must, nice) {
  const have = (s2) => mine.some((m) => m === s2 || m.includes(s2) || s2.includes(m));
  const mustHave = must.filter(have);
  const niceHave = nice.filter(have);
  const mustHit = must.length ? mustHave.length / must.length : null;
  const niceHit = nice.length ? niceHave.length / nice.length : null;
  if (mustHit === null && niceHit === null)
    return { evidence: null, missing: [], proven: 0, of: 0 };
  const evidence = mustHit !== null ? 0.35 + 0.55 * mustHit + 0.1 * (niceHit ?? mustHit) : 0.5 + 0.5 * niceHit;
  return { evidence, missing: must.filter((s2) => !have(s2)), proven: mustHave.length, of: must.length };
}
var STOP = /* @__PURE__ */ new Set(["the", "and", "for", "with", "that", "this", "who", "how", "their", "more", "than", "over", "across", "from", "into", "being", "want", "wants", "them", "they", "what", "when", "where", "will", "work"]);
var contentWords = (t) => t.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter((w) => w.length > 3 && !STOP.has(w));
function trajectoryFit(roleText, targetWords, aspireWords) {
  const targetHit = targetWords.length ? targetWords.filter((w) => roleText.includes(w)).length / targetWords.length : 0;
  if (!targetWords.length && !aspireWords.length)
    return { score: null, targetHit: 0 };
  const aspireHits = aspireWords.filter((w) => roleText.includes(w)).length;
  const aspire = aspireWords.length ? Math.min(1, aspireHits / 4) : null;
  const combined = targetWords.length && aspire !== null ? 0.7 * targetHit + 0.3 * aspire : targetWords.length ? targetHit : aspire;
  return { score: 0.5 + 0.5 * combined, targetHit };
}
function compRefine(pref, compMin, compMax, jobCurrency) {
  const exp = pref.expectedComp;
  if (!exp)
    return { factor: 1 };
  const userCur = pref.compCurrency ?? "INR";
  const top = compMax ?? compMin;
  if (!top)
    return { factor: 1 };
  const topUsd = toUSD(top, jobCurrency);
  const expUsd = toUSD(exp, userCur);
  if (topUsd === null || expUsd === null)
    return { factor: 1 };
  const floorUsd = toUSD(pref.acceptMin ?? pref.currentComp ?? exp * 0.85, userCur);
  if (topUsd >= expUsd)
    return { factor: 1, reason: `Comp clears your ${fmtMoney(exp, userCur)} target` };
  if (topUsd >= floorUsd)
    return { factor: 0.95, reason: `Comp inside your acceptable range` };
  const ratio = topUsd / expUsd;
  return { factor: Math.max(0.6, 0.6 + 0.4 * ratio), gap: `Comp below the floor you'd accept` };
}
function locationRefine(pref, remote, location) {
  let factor = 1;
  let reason;
  let gap;
  const want = pref.remote;
  const isRemote = remote === "remote";
  if (want && want !== "any" && remote && remote !== "unknown") {
    if (want === "remote" && !isRemote) {
      factor *= 0.7;
      gap = "Not remote \u2014 you wanted remote";
    } else if (want === "onsite" && isRemote) {
      factor *= 0.92;
    } else if (isRemote || want === remote) {
      reason = isRemote ? "Remote" : `${remote[0].toUpperCase()}${remote.slice(1)}`;
    }
  }
  const dreamHit = firstCityHit(location, pref.dreamCities);
  if (dreamHit) {
    factor *= 1.12;
    reason = `\u2728 ${dreamHit} \u2014 your dream city`;
  } else if (pref.locations?.length && !isRemote && location) {
    const hit = firstCityHit(location, pref.locations);
    if (hit)
      reason = reason ?? `In ${hit}`;
    else
      return { factor, reason, gap, exclude: true };
  }
  return { factor, reason, gap, exclude: false };
}
function whySummary(m) {
  const pct = Math.round(m.fit * 100);
  if (m.reasons.length) {
    const r = m.reasons.slice(0, 2).join(", and ").toLowerCase();
    return `${pct}% fit \u2014 ${r}${m.gaps.length ? `. Watch: ${m.gaps[0].toLowerCase()}` : ""}.`;
  }
  return `${pct}% fit for where you are right now.`;
}
function rankFromInputs(inputs, base) {
  const me = inputs.profile;
  const drift = me ? distillSignals(inputs.signals ?? []) : null;
  const vec = applyDrift(base, drift);
  const quals = applyQualOverrides(
    deriveCandidateQuals({ experiences: inputs.experiences ?? [], education: inputs.education ?? [], certifications: inputs.certifications ?? [] }),
    me?.aboutOverrides ?? null
  );
  const targetRole = (inputs.themes ?? []).find((a) => a?.kind === "target_role" && a.role && !a.pending)?.role ?? "";
  const aspireSents = (inputs.insights ?? []).filter((r) => r.dimension === "aspiration" || r.dimension === "value").slice(0, 3).map((r) => r.content ?? "").filter(Boolean);
  const targetWords = targetRole ? targetRole.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter((w) => w.length > 2) : [];
  const aspireWords = [...new Set(aspireSents.slice(0, 2).flatMap((s2) => contentWords(s2)))];
  const mySkills = (inputs.skills ?? []).map((s2) => normSkill(s2)).filter(Boolean);
  const pref = me?.preferences ?? {};
  const dismissed = new Set(inputs.dismissed ?? []);
  const undismissed = (inputs.pool ?? []).filter((r) => !dismissed.has(r.id));
  const real = undismissed.filter((r) => r.source !== "sample");
  const roles = real.length ? real : undismissed;
  const ranked = roles.map((r) => {
    const v = r.vector ?? {};
    const f = r.facts ?? {};
    const gate = hardGate({ facts: f, title: r.title }, quals);
    if (!gate.pass)
      return null;
    const m = scoreMatch(vec, v);
    const c = compRefine(pref, r.compMin, r.compMax, f.comp_currency ?? inferCurrency(r.location));
    const l = locationRefine(pref, r.remote, r.location);
    if (l.exclude)
      return null;
    const roleSkills = [...new Set([...f.must_have_skills ?? [], ...f.nice_to_have_skills ?? []].map(normSkill).filter(Boolean))];
    const ev = skillEvidence(mySkills, (f.must_have_skills ?? []).map(normSkill).filter(Boolean), (f.nice_to_have_skills ?? []).map(normSkill).filter(Boolean));
    const roleText = ` ${(r.title ?? "").toLowerCase()} ${(r.domain ?? "").toLowerCase()} ${(f.summary ?? "").toLowerCase()} ${roleSkills.join(" ")} `;
    const trajDist = r.trajDist;
    let traj;
    if (trajDist != null) {
      traj = {
        score: trajectoryFromCosine(1 - Number(trajDist)),
        targetHit: targetWords.length ? targetWords.filter((w) => roleText.includes(w)).length / targetWords.length : 0
      };
    } else {
      traj = trajectoryFit(roleText, targetWords, aspireWords);
    }
    const core = blendCore(m.desire, ev.evidence, traj.score);
    const rel = relevanceDamp(vec.seniority?.score ?? 0.5, ev.evidence, traj.score);
    const fit = Math.min(1, m.gate * core * rel * c.factor * l.factor * (gate.marginal?.penalty ?? 1));
    const reasons = [
      traj.targetHit >= 0.5 ? "The direction you set with your mentor" : null,
      ev.evidence !== null && ev.of > 0 && ev.proven / ev.of >= 0.7 ? `Your r\xE9sum\xE9 shows ${ev.proven} of ${ev.of} required skills` : null,
      c.reason,
      l.reason,
      ...m.reasons
    ].filter(Boolean);
    const gaps = [
      gate.marginal?.gap,
      ev.evidence !== null && ev.of > 0 && ev.proven / ev.of < 0.5 && ev.missing.length ? `Asks for ${ev.missing.slice(0, 3).join(", ")} \u2014 not on your r\xE9sum\xE9` : null,
      c.gap,
      l.gap,
      ...m.gaps
    ].filter(Boolean);
    const summary = f.summary?.trim() || (r.rawText ?? "").replace(/\s+/g, " ").trim().slice(0, 220);
    const coreRequirements = f.core_requirements?.length ? f.core_requirements : f.must_have_skills ?? [];
    const out = {
      id: r.id,
      title: r.title,
      company: r.company,
      location: r.location,
      country: inferCountry(r.location) ?? f.country ?? null,
      remote: r.remote,
      compMin: r.compMin,
      compMax: r.compMax,
      compCurrency: f.comp_currency ?? null,
      minYears: f.min_years_experience ?? null,
      domain: r.domain,
      url: r.url,
      source: r.source,
      summary,
      coreRequirements,
      skills: roleSkills,
      fit,
      qualification: m.qualification,
      desire: m.desire,
      evidence: ev.evidence,
      trajectory: traj.score,
      novelty: v.off_domain_novelty?.score ?? 0.3,
      building: v.off_building?.score ?? 0.5,
      peopleLeadership: v.off_people_leadership?.score ?? 0.3,
      reasons,
      gaps,
      why: whySummary({ fit, reasons, gaps })
    };
    return out;
  }).filter((j) => j !== null).sort((a, b) => b.fit - a.fit);
  const head = [];
  const tail = [];
  const perCompany = /* @__PURE__ */ new Map();
  for (const j of ranked) {
    const n = perCompany.get(j.company ?? "?") ?? 0;
    if (n < 2) {
      head.push(j);
      perCompany.set(j.company ?? "?", n + 1);
    } else
      tail.push(j);
  }
  return {
    matches: [...head, ...tail],
    learning: { active: !!drift && drift.confidence > 0, events: drift?.events ?? 0, confidence: drift?.confidence ?? 0 },
    userSkillKeys: mySkills
  };
}
export {
  SIGNAL_KINDS,
  applyDrift,
  applyQualOverrides,
  distillSignals,
  rankFromInputs,
  trajectoryFromCosine
};
