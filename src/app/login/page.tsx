import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/auth/session";
import HeroRoles from "./HeroRoles";
import FamousPivots from "./FamousPivots";
import MeaningMap from "./MeaningMap";
import OrbShowcase from "./OrbShowcase";

/**
 * The front door — the "Drizzle Landing" marketing page from the design kit.
 * Dark, warm, editorial (Newsreader serif + Hanken Grotesk). Every CTA is the
 * LinkedIn sign-in. Static server component; hover/animation live in globals.css.
 */
export const metadata = { title: "drizzle — a career copilot that knows you" };

const ACCENT = "#D07A54";
const HEADING = "#F1EADC";

function Mark({ size = 30, color = ACCENT }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" fill="none" aria-hidden>
      <path fillRule="evenodd" clipRule="evenodd" fill={color} d="M26 21a18 18 0 1 0 0 36 18 18 0 1 0 0-36ZM24 31c-4 4-6.5 7-6.5 10.5a6.5 6.5 0 0 0 13 0c0-3.5-2.5-6.5-6.5-10.5Z" />
      <rect x="40" y="6" width="8" height="49" rx="4" fill={color} />
    </svg>
  );
}

function LinkedInCTA({ size = "lg" }: { size?: "lg" | "md" }) {
  const pad = size === "lg" ? "17px 30px" : "16px 26px";
  const fs = size === "lg" ? 17 : 16.5;
  return (
    <a
      className="lp-li"
      href="/api/auth/linkedin"
      style={{ display: "inline-flex", alignItems: "center", gap: 11, background: "#0A66C2", color: "#fff", fontWeight: 700, fontSize: fs, padding: pad, borderRadius: 14, boxShadow: "0 18px 40px -14px rgba(10,102,194,0.8)" }}
    >
      <span style={{ width: 25, height: 25, borderRadius: 6, background: "#fff", display: "inline-flex", alignItems: "center", justifyContent: "center" }}>
        <svg width="15" height="15" viewBox="0 0 24 24" fill="#0A66C2" aria-hidden><path d="M20.45 20.45h-3.56v-5.57c0-1.33-.02-3.04-1.85-3.04-1.85 0-2.14 1.45-2.14 2.94v5.67H9.35V9h3.42v1.56h.05c.48-.9 1.64-1.85 3.37-1.85 3.6 0 4.27 2.37 4.27 5.46v6.28zM5.34 7.43a2.06 2.06 0 1 1 0-4.13 2.06 2.06 0 0 1 0 4.13zM7.12 20.45H3.55V9h3.57v11.45zM22.22 0H1.77C.79 0 0 .77 0 1.73v20.54C0 23.23.79 24 1.77 24h20.45c.98 0 1.78-.77 1.78-1.73V1.73C24 .77 23.2 0 22.22 0z" /></svg>
      </span>
      Continue with LinkedIn
    </a>
  );
}

const kicker = { fontSize: 11, fontWeight: 700, letterSpacing: "0.14em", textTransform: "uppercase" as const, color: ACCENT, marginBottom: 16 };
const h2Serif = { fontFamily: '"Newsreader", Georgia, serif', fontWeight: 500, color: HEADING, lineHeight: 1.1, letterSpacing: "-0.02em", margin: 0 } as const;
const pillar = { background: "#211D18", border: "1px solid rgba(230,210,170,0.10)", borderRadius: 20, padding: "32px 30px 34px" } as const;
const pillarIcon = { width: 52, height: 52, borderRadius: 14, background: "rgba(208,122,84,0.12)", border: "1px solid rgba(208,122,84,0.22)", display: "flex", alignItems: "center", justifyContent: "center", marginBottom: 22, color: "#D98E6A" } as const;
const pillarTitle = { fontFamily: '"Newsreader", Georgia, serif', fontWeight: 500, fontSize: 23, color: HEADING, letterSpacing: "-0.01em", marginBottom: 10 } as const;
const pillarBody = { fontSize: 15, lineHeight: 1.6, color: "#9E9484" } as const;

const SOURCES = ["Greenhouse", "Lever", "Ashby", "Workday", "LinkedIn"];
// real, atomic, canonically-cased skills (same taxonomy the app displays) for the
// landing's Data Analyst → Data Platform Engineer persona — NOT vague competencies.
// four keeps "Gaps to close" to a clean two rows (chips are wider than the
// strengths side because of the "N roles" demand tag)
const SKILLS = [
  { name: "Kubernetes", n: "6 roles" },
  { name: "Airflow", n: "5 roles" },
  { name: "Spark", n: "4 roles" },
  { name: "Terraform", n: "3 roles" },
];
const HAVE = ["Python ×24", "SQL ×18", "Tableau ×9", "dbt ×6", "Pandas ×5", "Excel ×4"];
// peers a step or two ahead on the same path. Photos are hotlinked stock
// placeholders (never committed); real mentor photos swap in later.
// a coherent real-world ladder for the "Data Analyst" persona — each peer one
// rung further, ending at the target role the diagnostic + Meaning Map point to
// (Data Platform Engineer). Not random trajectories.
const PEERS = [
  { name: "Priya Sharma", role: "Analytics Engineer", company: "Stripe", from: "Data Analyst", to: "Analytics Engineer", stepsLabel: "1 step ahead", mentored: "12 people", shared: "SQL & dbt in common", photo: "https://randomuser.me/api/portraits/women/26.jpg" },
  { name: "Marcus Reyes", role: "Data Engineer", company: "Ramp", from: "Analytics Engineer", to: "Data Engineer", stepsLabel: "2 steps ahead", mentored: "8 people", shared: "made the leap last year", photo: "https://randomuser.me/api/portraits/men/32.jpg" },
  { name: "Grace Kim", role: "Data Platform Engineer", company: "Figma", from: "Data Engineer", to: "Data Platform Engineer", stepsLabel: "3 steps ahead", mentored: "5 people", shared: "open to referrals", photo: "https://randomuser.me/api/portraits/women/44.jpg" },
];
const sageSm = { display: "inline-flex", alignItems: "center", gap: 6, padding: "6px 11px", borderRadius: 999, fontSize: 12.5, fontWeight: 600, background: "rgba(166,192,131,0.10)", color: "#A6C083", border: "1px solid rgba(166,192,131,0.18)" } as const;
const pTick = { flexShrink: 0, display: "inline-flex", alignItems: "center", justifyContent: "center", width: 18, height: 18, borderRadius: 6, background: "rgba(166,192,131,0.16)", color: "#A6C083", fontSize: 10, fontWeight: 800, marginTop: 1 } as const;
const pTickWarm = { ...pTick, background: "rgba(216,142,106,0.18)", color: "#E0A579" } as const;
const pTickMono = { ...pTick, background: "rgba(230,210,170,0.10)", color: "#B4AA98" } as const;
const priceCard = { display: "flex", flexDirection: "column" as const, background: "#211D18", border: "1px solid rgba(230,210,170,0.10)", borderRadius: 20, padding: "clamp(26px,3vw,32px)" } as const;
const priceBtn = { marginTop: "auto", textAlign: "center" as const, border: "1px solid rgba(230,210,170,0.22)", color: "#E7DECD", fontWeight: 600, fontSize: 15, padding: "13px 20px", borderRadius: 12, display: "block" } as const;

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  if (await getSessionUserId()) redirect("/dashboard");
  const { error } = await searchParams;

  return (
    <>
      {/* eslint-disable-next-line @next/next/no-page-custom-font */}
      <link href="https://fonts.googleapis.com/css2?family=Newsreader:ital,opsz,wght@0,6..72,400;0,6..72,500;0,6..72,600;1,6..72,400;1,6..72,500&family=Quicksand:wght@500;600;700&family=Hanken+Grotesk:wght@400;500;600;700&display=swap" rel="stylesheet" />
      <main className="lp">
        {/* ambient rain field */}
        <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 1100, overflow: "hidden", pointerEvents: "none", zIndex: 0 }}>
          <div className="lp-glow" style={{ position: "absolute", width: 760, height: 760, left: "50%", marginLeft: -380, top: -260, borderRadius: "50%", background: "radial-gradient(circle, rgba(208,122,84,0.16), transparent 66%)", filter: "blur(20px)", animation: "drz-glow 9s ease-in-out infinite" }} />
          <div style={{ position: "absolute", width: 520, height: 520, right: -140, top: 120, borderRadius: "50%", background: "radial-gradient(circle, rgba(120,95,60,0.14), transparent 70%)", filter: "blur(20px)" }} />
        </div>

        <div style={{ position: "relative", zIndex: 1, maxWidth: 1200, margin: "0 auto", padding: "0 clamp(20px,5vw,40px)" }}>
          {/* NAV */}
          <nav style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "24px 0 0" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <Mark size={30} />
              <span style={{ fontFamily: '"Quicksand", sans-serif', fontWeight: 600, fontSize: 22, color: "#ECE4D5", letterSpacing: "-0.02em" }}>drizzle</span>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 34 }}>
              {/* hidden ≤640px (see globals.css) — logo + Get started carry mobile */}
              <div className="lp-nav-links" style={{ display: "flex", alignItems: "center", gap: 30, fontSize: 14.5 }}>
                <a className="lp-link" href="#how">How it works</a>
                <a className="lp-link" href="#fit">Honest matching</a>
                <a className="lp-link" href="#community">Community</a>
                <a className="lp-link" href="#cost">At cost</a>
              </div>
              <a className="lp-cta" href="/api/auth/linkedin" style={{ background: ACCENT, color: "#14120E", fontWeight: 700, fontSize: 14.5, padding: "10px 20px", borderRadius: 11, boxShadow: "0 10px 26px -12px rgba(208,122,84,0.7)" }}>Get started</a>
            </div>
          </nav>

          {/* HERO */}
          <header style={{ padding: "clamp(60px,11vw,120px) 0 60px", textAlign: "center", display: "flex", flexDirection: "column", alignItems: "center" }}>
            <div style={{ display: "inline-flex", alignItems: "center", gap: 9, border: "1px solid rgba(230,210,170,0.14)", background: "rgba(230,210,170,0.04)", borderRadius: 999, padding: "7px 15px 7px 11px", marginBottom: 30 }}>
              <span className="lp-bob" style={{ display: "inline-flex", animation: "drz-bob 2.6s cubic-bezier(0.5,0,0.5,1) infinite", transformOrigin: "center bottom" }}>
                <svg width="13" height="13" viewBox="0 0 64 64" fill="none" aria-hidden><path fillRule="evenodd" clipRule="evenodd" fill={ACCENT} d="M32 8C24 20 18 30 18 40a14 14 0 0 0 28 0c0-10-6-20-14-32Z" /></svg>
              </span>
              <span style={{ fontSize: 12.5, fontWeight: 600, letterSpacing: "0.02em", color: "#C9BFAD", fontStyle: "italic", fontFamily: '"Newsreader", Georgia, serif' }}>the first rain after the drought</span>
            </div>

            <h1 className="lp-serif" style={{ fontWeight: 500, color: HEADING, fontSize: "clamp(42px,7.4vw,82px)", lineHeight: 1.02, letterSpacing: "-0.025em", margin: "0 0 24px", maxWidth: "15ch", textWrap: "balance" }}>
              A <span style={{ fontStyle: "italic", color: "#D98E6A" }}>career copilot</span> that knows you.
            </h1>

            <p style={{ fontSize: "clamp(17px,2.3vw,21px)", lineHeight: 1.55, color: "#A79E8D", margin: "0 0 40px", maxWidth: 640 }}>
              drizzle learns who you&apos;re <em style={{ color: "#C9BFAD", fontStyle: "italic" }}>becoming</em>, then aligns every role, the mentors ahead of you, and your next move to where you&apos;re headed — honestly, for the whole climb.
            </p>

            <div style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap", justifyContent: "center", marginBottom: 20 }}>
              <LinkedInCTA size="md" />
              <a className="lp-ghost" href="#how" style={{ display: "inline-flex", alignItems: "center", gap: 8, border: "1px solid rgba(230,210,170,0.18)", color: "#D6CCBA", fontWeight: 600, fontSize: 16.5, padding: "16px 24px", borderRadius: 14 }}>See how it works →</a>
            </div>
            {error && <p style={{ marginTop: 18, color: "#E0B45C", fontSize: 13 }}>Sign-in didn&apos;t complete ({error}). Please try again.</p>}
          </header>

          {/* HERO PRODUCT SHOT — the job slider: cycles diverse roles/geographies
              so everyone sees themselves in the first ten seconds (HeroRoles.tsx) */}
          <div style={{ perspective: 1600, marginBottom: 20 }}>
            <div className="lp-float" style={{ animation: "drz-float 8s ease-in-out infinite", willChange: "transform" }}>
              <HeroRoles />
            </div>
          </div>

          {/* trust sources */}
          <div style={{ textAlign: "center", padding: "56px 0 20px" }}>
            <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.14em", textTransform: "uppercase", color: "#6F6759", marginBottom: 20 }}>Pulls live roles from</div>
            <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "center", gap: "14px 40px" }}>
              {SOURCES.map((s) => (
                <span key={s} style={{ fontFamily: '"Newsreader", Georgia, serif', fontSize: 21, color: "#8A8172", letterSpacing: "-0.01em" }}>{s}</span>
              ))}
            </div>
          </div>
        </div>

        {/* HOW IT WORKS */}
        <section id="how" style={{ position: "relative", zIndex: 1, background: "#1A1712", borderTop: "1px solid rgba(230,210,170,0.07)", borderBottom: "1px solid rgba(230,210,170,0.07)", padding: "clamp(72px,10vw,120px) clamp(20px,5vw,40px)", marginTop: 60 }}>
          <div style={{ maxWidth: 1160, margin: "0 auto" }}>
            <div style={{ maxWidth: 640, marginBottom: 56 }}>
              <div style={kicker}>01 · One copilot, end to end</div>
              <h2 style={{ ...h2Serif, fontSize: "clamp(30px,4.6vw,50px)", lineHeight: 1.08 }}>A mentor who remembers —<br /><span style={{ fontStyle: "italic", color: "#D98E6A" }}>and does the rest.</span></h2>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(300px,1fr))", gap: 20, alignItems: "stretch" }}>
              {/* featured: the AI mentor, alive — reuses the real call-time VoiceOrb */}
              <div className="lp-pillar" style={{ display: "flex", flexDirection: "column", overflow: "hidden", background: "#211D18", border: "1px solid rgba(230,210,170,0.10)", borderRadius: 20 }}>
                <div style={{ height: 236, position: "relative", background: "radial-gradient(circle at 50% 42%, #221913 0%, #16110B 78%)", borderBottom: "1px solid rgba(230,210,170,0.08)" }}>
                  <OrbShowcase />
                </div>
                <div style={{ padding: "26px 30px 32px" }}>
                  <div style={{ ...pillarTitle, fontSize: 24 }}>Understands where you&apos;re headed</div>
                  <div style={pillarBody}>A short voice call reads who you&apos;re becoming — then drizzle surfaces the roles that fit and introduces you to people already on that path.</div>
                </div>
              </div>
              {/* two pointer cards */}
              <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
                <div className="lp-pillar" style={{ flex: 1, display: "flex", gap: 18, alignItems: "flex-start", ...pillar, padding: "28px 28px" }}>
                  <div style={{ ...pillarIcon, width: 50, height: 50, marginBottom: 0, flexShrink: 0 }}><svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden><circle cx="12" cy="12" r="8" stroke="#D98E6A" strokeWidth="1.8" /><circle cx="12" cy="12" r="3.4" stroke="#D98E6A" strokeWidth="1.8" /><circle cx="12" cy="12" r="0.6" fill="#D98E6A" /></svg></div>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ ...pillarTitle, fontSize: 22, marginBottom: 7 }}>Honestly matched roles</div>
                    <div style={{ ...pillarBody, fontSize: 14.5 }}>Ranked by what you&apos;d genuinely want and what the screen truly requires — the one watch-out surfaced, never buried.</div>
                  </div>
                </div>
                <div className="lp-pillar" style={{ flex: 1, display: "flex", gap: 18, alignItems: "flex-start", ...pillar, padding: "28px 28px" }}>
                  <div style={{ ...pillarIcon, width: 50, height: 50, marginBottom: 0, flexShrink: 0 }}><svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden><path d="M7 4h7l4 4v12H7z" stroke="#D98E6A" strokeWidth="1.8" strokeLinejoin="round" /><path d="M14 4v4h4" stroke="#D98E6A" strokeWidth="1.8" strokeLinejoin="round" /><path d="M9.5 12.5h5M9.5 15.5h5" stroke="#D98E6A" strokeWidth="1.6" strokeLinecap="round" /></svg></div>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ ...pillarTitle, fontSize: 22, marginBottom: 7 }}>Apply in one motion</div>
                    <div style={{ ...pillarBody, fontSize: 14.5 }}>Tailored résumé, cover letter, and every fiddly application answer — staged the moment you click apply.</div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* HONEST MATCHING · trajectory map + the two-read diagnostic */}
        <section id="fit" style={{ position: "relative", zIndex: 1, padding: "clamp(72px,10vw,120px) clamp(20px,5vw,40px)" }}>
          <div style={{ maxWidth: 1000, margin: "0 auto" }}>
            <div style={{ maxWidth: 680, margin: "0 auto 44px", textAlign: "center" }}>
              <div style={kicker}>02 · A direction, not a keyword</div>
              <h2 style={{ ...h2Serif, fontSize: "clamp(30px,4.4vw,48px)", lineHeight: 1.1, margin: "0 0 20px" }}>Ranked to where you&apos;re going — not what you&apos;re called.</h2>
              <p style={{ fontSize: 16.5, lineHeight: 1.6, color: "#A79E8D", margin: 0 }}>We match on <em style={{ color: "#C9BFAD" }}>trajectory</em>, not keywords. From one starting point we surface the paths open to you — even roles that share zero words with your past — then help you refine the one that fits.</p>
            </div>

            <div style={{ maxWidth: 760, margin: "0 auto" }}>
              <MeaningMap />
            </div>

            <div style={{ marginTop: "clamp(46px,6vw,76px)", maxWidth: 860, marginLeft: "auto", marginRight: "auto" }}>
              <div style={{ textAlign: "center", marginBottom: 26 }}>
                <div style={kicker}>The diagnostic</div>
                <h3 style={{ ...h2Serif, fontSize: "clamp(22px,3vw,30px)", lineHeight: 1.15, margin: 0 }}>Two honest reads on where you stand.</h3>
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(262px,1fr))", gap: 16 }}>
                {/* A: strengths */}
                <div style={{ background: "#211D18", border: "1px solid rgba(230,210,170,0.10)", borderRadius: 16, padding: "22px 24px" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16 }}>
                    <span style={{ width: 24, height: 24, borderRadius: 7, background: "rgba(166,192,131,0.16)", color: "#A6C083", fontWeight: 800, fontSize: 12, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>A</span>
                    <span style={{ fontSize: 14.5, fontWeight: 700, color: "#E7DECD" }}>Already strong at</span>
                  </div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                    {HAVE.map((h) => (
                      <span key={h} style={sageSm}><span style={{ color: "#A6C083" }}>✓</span> {h}</span>
                    ))}
                  </div>
                </div>

                {/* B: gaps */}
                <div style={{ background: "#211D18", border: "1px solid rgba(230,210,170,0.10)", borderRadius: 16, padding: "22px 24px" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16 }}>
                    <span style={{ width: 24, height: 24, borderRadius: 7, background: "rgba(216,142,106,0.18)", color: "#E0A579", fontWeight: 800, fontSize: 12, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>B</span>
                    <span style={{ fontSize: 14.5, fontWeight: 700, color: "#E7DECD" }}>Gaps to close</span>
                  </div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                    {SKILLS.map((s) => (
                      <span key={s.name} style={{ display: "inline-flex", alignItems: "center", gap: 7, background: "rgba(216,142,106,0.10)", border: "1px solid rgba(216,142,106,0.22)", color: "#E7DECD", fontSize: 13, fontWeight: 600, padding: "6px 12px", borderRadius: 999 }}>{s.name} <span style={{ color: "#8A8172", fontWeight: 500 }}>{s.n}</span></span>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* COMMUNITY — mentor connect */}
        <section id="community" style={{ position: "relative", zIndex: 1, background: "#1A1712", borderTop: "1px solid rgba(230,210,170,0.07)", padding: "clamp(72px,10vw,120px) clamp(20px,5vw,40px)" }}>
          <div style={{ maxWidth: 1160, margin: "0 auto" }}>
            <div style={{ maxWidth: 660, marginBottom: 40 }}>
              <div style={kicker}>03 · Your circle</div>
              <h2 style={{ ...h2Serif, fontSize: "clamp(30px,4.6vw,50px)", lineHeight: 1.08, margin: "0 0 20px" }}>Build a professional network that <span style={{ fontStyle: "italic", color: "#D98E6A" }}>truly matters.</span></h2>
              <p style={{ fontSize: 16.5, lineHeight: 1.6, color: "#A79E8D", margin: 0, maxWidth: 600 }}>Not a feed of strangers — drizzle introduces you to people a step or two ahead on your exact path, for honest advice, warm intros, and proof the leap is makeable.</p>
            </div>

            {/* you are here */}
            <div style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap", marginBottom: 30 }}>
              <span style={{ width: 44, height: 44, borderRadius: "50%", flexShrink: 0, background: "#211D18", border: "2px dashed rgba(216,142,106,0.55)", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 700, fontSize: 11, letterSpacing: "0.05em", color: "#E7DECD" }}>YOU</span>
              <span style={{ fontFamily: '"Newsreader", Georgia, serif', fontSize: 19, color: HEADING }}>Here now — <span style={{ fontStyle: "italic", color: "#D98E6A" }}>Data Analyst.</span></span>
              <span style={{ fontSize: 14.5, color: "#8A8172" }}>Here&apos;s who&apos;s just up ahead on your path.</span>
            </div>

            {/* mentor cards */}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(318px,1fr))", gap: 20, alignItems: "stretch" }}>
              {PEERS.map((p) => (
                <div key={p.name} className="lp-pillar" style={{ display: "flex", flexDirection: "column", background: "#211D18", border: "1px solid rgba(230,210,170,0.10)", borderRadius: 18, padding: "clamp(22px,2.4vw,26px)", boxShadow: "0 26px 60px -46px rgba(0,0,0,0.9)" }}>
                  <div style={{ marginBottom: 18 }}><span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 10.5, fontWeight: 700, letterSpacing: "0.07em", textTransform: "uppercase", color: "#E0A579", background: "rgba(216,142,106,0.10)", border: "1px solid rgba(216,142,106,0.24)", borderRadius: 999, padding: "6px 12px" }}><span style={{ fontSize: 8, letterSpacing: "-2px" }}>▲</span> {p.stepsLabel}</span></div>
                  <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={p.photo} alt="" width={56} height={56} style={{ width: 56, height: 56, borderRadius: "50%", objectFit: "cover", flexShrink: 0, boxShadow: "0 0 0 1px rgba(255,240,210,0.16), 0 6px 16px -6px rgba(0,0,0,0.6)" }} />
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div style={{ fontSize: 16.5, fontWeight: 700, color: HEADING, lineHeight: 1.2 }}>{p.name}</div>
                      <div style={{ fontSize: 13.5, color: "#948B7C", marginTop: 2 }}>{p.role} · {p.company}</div>
                      <div style={{ fontSize: 12, color: "#7C7365", marginTop: 4 }}>Mentored {p.mentored} on this path</div>
                    </div>
                  </div>
                  <div style={{ marginTop: 18, display: "flex", alignItems: "center", gap: 11, flexWrap: "wrap", background: "rgba(230,210,170,0.035)", border: "1px solid rgba(230,210,170,0.07)", borderRadius: 12, padding: "12px 15px" }}>
                    <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: "#8A8172" }}>Their leap</span>
                    <span style={{ fontFamily: '"Newsreader", Georgia, serif', fontSize: 16, color: "#948B7C" }}>{p.from}</span>
                    <span style={{ color: ACCENT, fontWeight: 700 }}>→</span>
                    <span style={{ fontFamily: '"Newsreader", Georgia, serif', fontSize: 17, color: "#F4EEE1" }}>{p.to}</span>
                  </div>
                  <div style={{ marginTop: "auto", paddingTop: 18, display: "flex", flexDirection: "column", gap: 14 }}>
                    <span style={{ ...sageSm, alignSelf: "flex-start" }}><span style={{ color: "#A6C083" }}>✓</span> {p.shared}</span>
                    <a className="lp-ghost" href="/api/auth/linkedin" style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 8, background: "rgba(216,142,106,0.12)", border: "1px solid rgba(216,142,106,0.3)", color: "#F1D9C6", fontWeight: 600, fontSize: 14.5, padding: "12px 18px", borderRadius: 11 }}>Request intro <span style={{ color: ACCENT }}>→</span></a>
                  </div>
                </div>
              ))}
            </div>

            <div style={{ marginTop: 30, display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
              <div style={{ display: "flex" }}>
                {["men/45", "women/12", "men/76"].map((f, i) => (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img key={f} src={`https://randomuser.me/api/portraits/${f}.jpg`} alt="" width={36} height={36} style={{ width: 36, height: 36, borderRadius: "50%", objectFit: "cover", border: "2px solid #1A1712", marginLeft: i ? -11 : 0 }} />
                ))}
              </div>
              <span style={{ fontSize: 15, color: "#948B7C" }}><span style={{ color: "#C9BFAD", fontWeight: 600 }}>200+ more</span> climbing the same path right now.</span>
            </div>
          </div>
        </section>

        {/* AT COST · pricing + "I'm broke" mode */}
        <section id="cost" style={{ position: "relative", zIndex: 1, background: "#1A1712", borderTop: "1px solid rgba(230,210,170,0.07)", padding: "clamp(72px,10vw,120px) clamp(20px,5vw,40px)" }}>
          <div style={{ maxWidth: 1160, margin: "0 auto" }}>
            <div style={{ maxWidth: 660, margin: "0 auto clamp(40px,5vw,56px)", textAlign: "center" }}>
              <div style={{ display: "inline-flex", alignItems: "center", gap: 9, border: "1px solid rgba(166,192,131,0.28)", background: "rgba(166,192,131,0.08)", borderRadius: 999, padding: "7px 16px", marginBottom: 22, fontSize: 12.5, fontWeight: 700, letterSpacing: "0.04em", color: "#A6C083" }}>04 · Runs at cost</div>
              <h2 style={{ ...h2Serif, fontSize: "clamp(30px,4.4vw,48px)", lineHeight: 1.12, margin: "0 0 16px", textWrap: "balance" }}>A career runs 40 years. <span style={{ fontStyle: "italic", color: "#D98E6A" }}>Investing in yours is the best return there is.</span></h2>
              <p style={{ fontSize: "clamp(16px,2vw,18px)", lineHeight: 1.6, color: "#A79E8D", margin: 0 }}>So we price at cost — enough to keep the lights on, never a cent for profit. Free while you&apos;re finding your footing; step up only when you want more.</p>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(268px,1fr))", gap: 18, alignItems: "stretch", maxWidth: 1040, margin: "0 auto" }}>
              {/* FREE */}
              <div style={priceCard}>
                <div style={{ fontFamily: '"Newsreader", Georgia, serif', fontSize: 22, color: HEADING }}>Free</div>
                <div style={{ fontSize: 13.5, color: "#8A8172", margin: "4px 0 20px" }}>While you&apos;re finding your footing</div>
                <div style={{ display: "flex", alignItems: "baseline", gap: 4, marginBottom: 22 }}><span style={{ fontFamily: '"Newsreader", Georgia, serif', fontSize: 44, color: "#F4EEE1", lineHeight: 1 }}>$0</span><span style={{ fontSize: 14, color: "#8A8172" }}>/mo</span></div>
                <div style={{ height: 1, background: "rgba(230,210,170,0.09)", marginBottom: 20 }} />
                <div style={{ display: "flex", flexDirection: "column", gap: 13, marginBottom: 28 }}>
                  {["Your trajectory map & honest match scores", "5 tailored recommendations / mo", "Résumé diagnostic — strengths & gaps", "Sign up as a mentor — offer help & earn"].map((t) => (
                    <div key={t} style={{ display: "flex", gap: 11, alignItems: "flex-start" }}><span style={pTick}>✓</span><span style={{ fontSize: 14.5, color: "#B9B0A0" }}>{t}</span></div>
                  ))}
                </div>
                <a className="lp-ghost" href="/api/auth/linkedin" style={priceBtn}>Start free</a>
              </div>

              {/* STARTER */}
              <div style={priceCard}>
                <div style={{ fontFamily: '"Newsreader", Georgia, serif', fontSize: 22, color: HEADING }}>Starter</div>
                <div style={{ fontSize: 13.5, color: "#8A8172", margin: "4px 0 20px" }}>About two coffees a month</div>
                <div style={{ display: "flex", alignItems: "baseline", gap: 4, marginBottom: 22 }}><span style={{ fontFamily: '"Newsreader", Georgia, serif', fontSize: 44, color: "#F4EEE1", lineHeight: 1 }}>$9.99</span><span style={{ fontSize: 14, color: "#8A8172" }}>/mo</span></div>
                <div style={{ height: 1, background: "rgba(230,210,170,0.09)", marginBottom: 20 }} />
                <div style={{ fontSize: 12.5, fontWeight: 600, color: "#948B7C", marginBottom: 14 }}>Everything in Free, plus</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 13, marginBottom: 28 }}>
                  {["20 tailored recommendations / mo", "1 mentor call / mo", "2 warm intros / mo", "5 résumé edits / mo"].map((t) => (
                    <div key={t} style={{ display: "flex", gap: 11, alignItems: "flex-start" }}><span style={pTick}>✓</span><span style={{ fontSize: 14.5, color: "#B9B0A0" }}>{t}</span></div>
                  ))}
                </div>
                <a className="lp-ghost" href="/api/auth/linkedin" style={priceBtn}>Choose Starter</a>
              </div>

              {/* PRO */}
              <div style={{ ...priceCard, position: "relative", background: "linear-gradient(#241C15, #211D18)", border: "1px solid rgba(216,142,106,0.42)", boxShadow: "0 30px 70px -44px rgba(216,142,106,0.5)" }}>
                <div style={{ position: "absolute", top: -11, left: "50%", transform: "translateX(-50%)", background: "linear-gradient(135deg,#E39B72,#C15F3C)", color: "#221008", fontWeight: 800, fontSize: 10.5, letterSpacing: "0.08em", textTransform: "uppercase", padding: "6px 14px", borderRadius: 999, whiteSpace: "nowrap" }}>Most chosen</div>
                <div style={{ fontFamily: '"Newsreader", Georgia, serif', fontSize: 22, color: "#F6EFE2" }}>Pro</div>
                <div style={{ fontSize: 13.5, color: "#B79A82", margin: "4px 0 20px" }}>For an all-in search</div>
                <div style={{ display: "flex", alignItems: "baseline", gap: 4, marginBottom: 22 }}><span style={{ fontFamily: '"Newsreader", Georgia, serif', fontSize: 44, color: "#FBF4E9", lineHeight: 1 }}>$19.99</span><span style={{ fontSize: 14, color: "#B79A82" }}>/mo</span></div>
                <div style={{ height: 1, background: "rgba(216,142,106,0.22)", marginBottom: 20 }} />
                <div style={{ fontSize: 12.5, fontWeight: 600, color: "#C79A7C", marginBottom: 14 }}>Everything in Starter, plus</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 13, marginBottom: 28 }}>
                  {["50 tailored recommendations / mo", "5 mentor calls / mo", "5 warm intros / mo", "Unlimited résumé edits", "Early access to new roles as they surface"].map((t) => (
                    <div key={t} style={{ display: "flex", gap: 11, alignItems: "flex-start" }}><span style={pTickWarm}>✓</span><span style={{ fontSize: 14.5, color: "#D6CCBB" }}>{t}</span></div>
                  ))}
                </div>
                <a className="lp-cta" href="/api/auth/linkedin" style={{ marginTop: "auto", textAlign: "center", background: "linear-gradient(135deg,#E39B72,#C15F3C)", color: "#fff", fontWeight: 700, fontSize: 15, padding: "14px 20px", borderRadius: 12, boxShadow: "0 16px 34px -14px rgba(216,142,106,0.7)", display: "block" }}>Choose Pro</a>
              </div>
            </div>

            {/* "I'm broke" mode */}
            <div style={{ marginTop: "clamp(30px,4vw,44px)", maxWidth: 1040, marginLeft: "auto", marginRight: "auto", borderRadius: 20, border: "1px solid rgba(230,210,170,0.14)", background: "#1E1A15", padding: "clamp(28px,3.4vw,40px)" }}>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(280px,1fr))", gap: "clamp(24px,4vw,44px)", alignItems: "center" }}>
                {/* cinematic panel */}
                <div style={{ position: "relative", width: "100%", aspectRatio: "4 / 3", minHeight: 248, borderRadius: 16, overflow: "hidden", background: "linear-gradient(#100D09 0%, #16110C 48%, #241812 100%)", boxShadow: "inset 0 0 0 1px rgba(230,210,170,0.08), inset 0 -50px 100px -40px rgba(193,95,60,0.28)" }}>
                  <div style={{ position: "absolute", left: "50%", bottom: "-14%", transform: "translateX(-50%)", width: "70%", height: "52%", borderRadius: "50%", background: "radial-gradient(circle, rgba(230,150,96,0.55), rgba(216,120,80,0.12) 55%, transparent 72%)", filter: "blur(6px)" }} />
                  <div className="lp-rain" style={{ position: "absolute", inset: "-24px 0 0 0", backgroundImage: "repeating-linear-gradient(102deg, transparent 0, transparent 13px, rgba(230,220,205,0.05) 13px, rgba(230,220,205,0.05) 14px)", pointerEvents: "none" }} />
                  <svg viewBox="0 0 400 320" preserveAspectRatio="xMidYMax meet" style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }} aria-hidden>
                    <defs>
                      <linearGradient id="pathG" x1="0" y1="1" x2="0" y2="0"><stop offset="0" stopColor="#E39B72" stopOpacity="0.55" /><stop offset="1" stopColor="#E39B72" stopOpacity="0" /></linearGradient>
                      <linearGradient id="figRim" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stopColor="#E39B72" stopOpacity="0" /><stop offset="1" stopColor="#F0B98C" stopOpacity="0.5" /></linearGradient>
                    </defs>
                    <path d="M200,300 C170,230 120,190 96,120" fill="none" stroke="url(#pathG)" strokeWidth="1.5" strokeDasharray="2 8" strokeLinecap="round" opacity="0.6" />
                    <path d="M200,300 C232,232 282,192 306,120" fill="none" stroke="url(#pathG)" strokeWidth="1.5" strokeDasharray="2 8" strokeLinecap="round" opacity="0.6" />
                    <path className="lp-pathpulse" d="M200,300 C200,224 200,180 200,108" fill="none" stroke="url(#pathG)" strokeWidth="2.4" strokeDasharray="3 7" strokeLinecap="round" />
                    <circle cx="200" cy="104" r="4.5" fill="#F3C79C" /><circle cx="200" cy="104" r="10" fill="#F0B98C" opacity="0.25" />
                    <g><path d="M181,196 C182,180 218,180 219,196 C223,220 222,252 220,276 C219,281 181,281 180,276 C178,252 177,220 181,196 Z" fill="#0B0806" /><ellipse cx="200" cy="181" rx="18" ry="21" fill="#0B0806" /><ellipse cx="200" cy="176" rx="13.5" ry="15" fill="#0B0806" /><path d="M181,196 C182,180 218,180 219,196 C223,220 222,252 220,276" fill="none" stroke="url(#figRim)" strokeWidth="1" /></g>
                  </svg>
                  <div style={{ position: "absolute", inset: 0, boxShadow: "inset 0 0 90px 30px rgba(8,6,5,0.7)", pointerEvents: "none" }} />
                  <div style={{ position: "absolute", left: 0, right: 0, bottom: 18, textAlign: "center", padding: "0 20px", pointerEvents: "none" }}>
                    <div style={{ fontFamily: '"Newsreader", Georgia, serif', fontStyle: "italic", fontSize: "clamp(14px,1.8vw,16px)", color: "#F1E3D3", textShadow: "0 2px 12px rgba(0,0,0,0.6)" }}>Which way now?</div>
                  </div>
                </div>
                {/* content */}
                <div>
                  <div style={{ display: "flex", alignItems: "center", gap: 11 }}>
                    <Mark size={24} color="#B4AA98" />
                    <h3 style={{ ...h2Serif, fontWeight: 500, fontSize: "clamp(25px,3.2vw,32px)", margin: 0, lineHeight: 1 }}>&ldquo;I&apos;m broke&rdquo; mode</h3>
                  </div>
                  <p style={{ fontSize: 15.5, lineHeight: 1.6, color: "#A79E8D", margin: "16px 0 0" }}>Everything in Pro — free for now, pay it forward when you land. We built drizzle after watching good people face a lost job alone; this is that moment.</p>
                  <div style={{ marginTop: 18, display: "flex", flexDirection: "column", gap: 12 }}>
                    {["Full Pro access — no card required", "Pay it forward once you're back on your feet"].map((t) => (
                      <div key={t} style={{ display: "flex", gap: 11, alignItems: "flex-start" }}><span style={pTickMono}>✓</span><span style={{ fontSize: 14.5, color: "#B9B0A0" }}>{t}</span></div>
                    ))}
                  </div>
                  <div style={{ marginTop: 24, display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
                    <a className="lp-ghost" href="/api/auth/linkedin" style={{ display: "inline-flex", alignItems: "center", gap: 8, border: "1px solid rgba(230,210,170,0.28)", background: "rgba(230,210,170,0.06)", color: HEADING, fontWeight: 700, fontSize: 15, padding: "13px 24px", borderRadius: 12, whiteSpace: "nowrap" }}>Reach out <span style={{ color: "#B4AA98" }}>→</span></a>
                    <span style={{ fontSize: 12.5, color: "#8A8172", maxWidth: 170 }}>Approved by a real person — usually same day.</span>
                  </div>
                </div>
              </div>
            </div>

            <p style={{ textAlign: "center", fontSize: 13.5, color: "#7C7365", margin: "26px auto 0", maxWidth: 520 }}>Cancel anytime — no lock-in, ever.</p>
          </div>
        </section>

        {/* FINAL CTA */}
        <section id="start" style={{ position: "relative", zIndex: 1, padding: "clamp(80px,12vw,140px) clamp(20px,5vw,40px)", textAlign: "center", overflow: "hidden" }}>
          <div style={{ position: "absolute", width: 620, height: 620, left: "50%", top: "50%", transform: "translate(-50%,-50%)", borderRadius: "50%", background: "radial-gradient(circle, rgba(208,122,84,0.16), transparent 66%)", filter: "blur(30px)", pointerEvents: "none" }} />
          <div style={{ position: "relative", display: "flex", flexDirection: "column", alignItems: "center" }}>
            <div className="lp-bob" style={{ animation: "drz-bob 2.6s cubic-bezier(0.5,0,0.5,1) infinite", transformOrigin: "center bottom", marginBottom: 26 }}><Mark size={52} /></div>
            <h2 style={{ ...h2Serif, fontSize: "clamp(34px,5.6vw,62px)", lineHeight: 1.05, letterSpacing: "-0.025em", margin: "0 0 22px", maxWidth: "16ch", textWrap: "balance" }}>Clarity today. A better career tomorrow.</h2>
            <p style={{ fontSize: 18, color: "#A79E8D", margin: "0 0 36px", maxWidth: 460 }}>One sign-in with LinkedIn and your copilot starts learning who you&apos;re becoming.</p>
            <LinkedInCTA />
            <div style={{ fontSize: 13, color: "#7C7365", marginTop: 18 }}>We only read your name, email, and photo to set up your account.</div>

            {/* aspirational figures — pop in one at a time, just below the CTA */}
            <FamousPivots />
          </div>
        </section>

        {/* FOOTER */}
        <footer style={{ position: "relative", zIndex: 1, borderTop: "1px solid rgba(230,210,170,0.07)", padding: "34px clamp(20px,5vw,40px)" }}>
          <div style={{ maxWidth: 1160, margin: "0 auto", display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 16 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
              <Mark size={22} color="#8A8172" />
              <span style={{ fontFamily: '"Quicksand", sans-serif', fontWeight: 600, fontSize: 16, color: "#8A8172" }}>drizzle</span>
            </div>
            <div style={{ fontSize: 13, color: "#6F6759" }}>© 2026 drizzle · the first rain after the drought</div>
          </div>
        </footer>
      </main>
    </>
  );
}
