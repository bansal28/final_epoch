"use client";

import { useEffect, useMemo, useState } from "react";
import { Search, GitCommit, Mic, Volume2, MessageSquare, AlertTriangle } from "lucide-react";
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid
} from "recharts";

const API = process.env.NEXT_PUBLIC_API_BASE ?? "http://127.0.0.1:8000";

type Bundle = {
  site_bundle_id: string;
  council_name: string;
  n_apps: number;
  sample_address: string;
  first_app: string;
  last_app: string;
};

export default function Home() {
  const [council, setCouncil] = useState("");
  const [q, setQ] = useState("");
  const [minApps, setMinApps] = useState(5);
  const [bundles, setBundles] = useState<Bundle[]>([]);
  const [selected, setSelected] = useState<string | null>(null);

  const [commits, setCommits] = useState<any[]>([]);
  const [overview, setOverview] = useState<any | null>(null);

  const [question, setQuestion] = useState("");
  const [chat, setChat] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Load bundles
  useEffect(() => {
    const run = async () => {
      setErr(null);
      try {
        const u = new URL(API + "/bundles");
        if (council) u.searchParams.set("council", council);
        if (q) u.searchParams.set("q", q);
        u.searchParams.set("min_apps", String(minApps));
        u.searchParams.set("limit", "200");

        const res = await fetch(u.toString());
        if (!res.ok) throw new Error(`Bundles HTTP ${res.status}`);
        const data = await res.json();

        setBundles(Array.isArray(data) ? data : []);
        if (!selected && data?.[0]?.site_bundle_id) setSelected(data[0].site_bundle_id);
      } catch (e: any) {
        setErr(`Failed to load bundles: ${e?.message || e}`);
        setBundles([]);
      }
    };
    run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [council, q, minApps]);

  // Load repo + overview when selected changes
  useEffect(() => {
    if (!selected) return;
    const run = async () => {
      setErr(null);
      try {
        const [r1, r2] = await Promise.all([
          fetch(`${API}/repo/${selected}`),
          fetch(`${API}/repo/${selected}/overview`)
        ]);

        if (!r1.ok) throw new Error(`Repo HTTP ${r1.status}`);
        if (!r2.ok) throw new Error(`Overview HTTP ${r2.status}`);

        const repoData = await r1.json();
        const ov = await r2.json();

        setCommits(repoData.commits || []);
        setOverview(ov);
        setChat([
          { role: "assistant", text: "Open a repo and ask me: “What changed recently and what should I do next?” I’ll cite commits so you can verify." }
        ]);
        setQuestion("");
      } catch (e: any) {
        setErr(`Failed to load repo: ${e?.message || e}`);
        setCommits([]);
        setOverview(null);
      }
    };
    run();
  }, [selected]);

  async function ask(text: string) {
    if (!selected) return;
    setLoading(true);
    setErr(null);
    setChat((c: any[]) => [...c, { role: "user", text }]);

    try {
      const res = await fetch(`${API}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bundle_id: selected, question: text }),
      });

      if (!res.ok) {
        const t = await res.text();
        throw new Error(`Chat HTTP ${res.status}: ${t.slice(0, 200)}`);
      }

      const data = await res.json();
      setChat((c: any[]) => [...c, { role: "assistant", text: data.answer || "No answer returned.", citations: data.citations || [] }]);
    } catch (e: any) {
      setErr(`Chat failed: ${e?.message || e}`);
      setChat((c: any[]) => [...c, { role: "assistant", text: "Chat is unavailable right now. Check backend /chat and GEMINI_API_KEY (optional).", citations: [] }]);
    }

    setLoading(false);
  }

  async function speak(text: string) {
    setErr(null);
    try {
      const res = await fetch(`${API}/tts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (!res.ok) {
        const t = await res.text();
        throw new Error(`TTS HTTP ${res.status}: ${t.slice(0, 200)}`);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      new Audio(url).play();
    } catch (e: any) {
      setErr(`Voice failed: ${e?.message || e}`);
    }
  }

  function voiceAsk() {
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SR) {
      setErr("Voice input requires Chrome (SpeechRecognition not supported here).");
      return;
    }
    const rec = new SR();
    rec.lang = "en-GB";
    rec.interimResults = false;
    rec.onresult = (e: any) => ask(e.results[0][0].transcript);
    rec.start();
  }

  const typeChartData = useMemo(() => {
    if (!overview?.type_counts) return [];
    return Object.entries(overview.type_counts).map(([name, value]) => ({ name, value }));
  }, [overview]);

  const decisionChartData = useMemo(() => {
    if (!overview?.decision_counts) return [];
    return Object.entries(overview.decision_counts).map(([name, value]) => ({ name, value }));
  }, [overview]);

  return (
    <div className="min-h-screen bg-gradient-to-br from-zinc-50 via-white to-sky-50 text-zinc-900">
      <div className="grid grid-cols-[420px_1fr] min-h-screen">
        {/* Sidebar */}
        <aside className="border-r border-zinc-200 bg-white/70 backdrop-blur p-5 space-y-4">
          <div className="flex items-center gap-2">
            <GitCommit className="w-5 h-5 text-indigo-600" />
            <h1 className="text-xl font-semibold">Planning GitHub</h1>
          </div>

          <div className="rounded-2xl border border-zinc-200 bg-white p-3 space-y-3 shadow-sm">
            <div className="flex items-center gap-2 text-zinc-600">
              <Search className="w-4 h-4" />
              <input
                className="w-full bg-transparent outline-none"
                placeholder="Search address…"
                value={q}
                onChange={(e) => setQ(e.target.value)}
              />
            </div>

            <input
              className="w-full bg-zinc-50 border border-zinc-200 rounded-xl px-3 py-2"
              placeholder="Council filter (e.g. Camden)"
              value={council}
              onChange={(e) => setCouncil(e.target.value)}
            />

            <div className="flex items-center justify-between text-sm text-zinc-600">
              <span>Min commits</span>
              <input
                type="number"
                className="w-20 bg-zinc-50 border border-zinc-200 rounded-xl px-2 py-1"
                value={minApps}
                onChange={(e) => setMinApps(parseInt(e.target.value || "5"))}
              />
            </div>
          </div>

          <div className="text-sm text-zinc-600">Repos</div>
          <div className="space-y-2 max-h-[78vh] overflow-auto pr-1">
            {bundles.map((b) => (
              <button
                key={b.site_bundle_id}
                onClick={() => setSelected(b.site_bundle_id)}
                className={`w-full text-left rounded-2xl p-3 border shadow-sm ${
                  selected === b.site_bundle_id
                    ? "border-indigo-300 bg-indigo-50"
                    : "border-zinc-200 bg-white hover:border-indigo-200"
                } transition`}
              >
                <div className="flex items-center justify-between">
                  <div className="font-medium">{b.council_name}</div>
                  <div className="text-xs text-zinc-500">{b.n_apps} commits</div>
                </div>
                <div className="text-xs text-zinc-600 mt-1 line-clamp-2">{b.sample_address}</div>
                <div className="text-[11px] text-zinc-500 mt-2">
                  {String(b.first_app).slice(0, 10)} → {String(b.last_app).slice(0, 10)}
                </div>
              </button>
            ))}
          </div>
        </aside>

        {/* Main */}
        <main className="p-6 grid grid-cols-[1fr_420px] gap-6">
          {/* Repo + Insights */}
          <section className="space-y-4">
            {err ? (
              <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-amber-900 flex gap-2">
                <AlertTriangle className="w-5 h-5" />
                <div className="text-sm">{err}</div>
              </div>
            ) : null}

            <div className="rounded-3xl border border-zinc-200 bg-white p-5 shadow-sm">
              <div className="text-sm text-zinc-600">Repo</div>
              <div className="text-lg font-semibold">{selected ?? "Pick a repo"}</div>
              {overview?.latest?.url ? (
                <a className="text-sm text-indigo-600 hover:underline" href={overview.latest.url} target="_blank">
                  Open latest portal ↗
                </a>
              ) : null}
            </div>

            {/* Overview KPIs */}
            {overview ? (
              <div className="grid grid-cols-4 gap-3">
                <Kpi label="Commits" value={overview.n_commits} />
                <Kpi label="Stage" value={overview.stage} />
                <Kpi label="Days span" value={overview.days_span ?? "—"} />
                <Kpi label="Churn" value={overview.churn_score} />
              </div>
            ) : null}

            {/* Charts + Actions */}
            <div className="grid grid-cols-2 gap-4">
              <Panel title="Most common application types">
                <Chart data={typeChartData} />
              </Panel>

              <Panel title="Decision mix">
                <Chart data={decisionChartData} />
              </Panel>

              <Panel title="Key insights">
                <ul className="space-y-2 text-sm text-zinc-700">
                  {(overview?.insights?.length ? overview.insights : ["No insights available yet."]).map((t: string, i: number) => (
                    <li key={i} className="leading-snug">• {t}</li>
                  ))}
                </ul>
              </Panel>

              <Panel title="Next actions for a developer">
                <ol className="space-y-2 text-sm text-zinc-700 list-decimal ml-5">
                  {(overview?.next_actions?.length ? overview.next_actions : ["Select a repo to see actions."]).map((t: string, i: number) => (
                    <li key={i} className="leading-snug">{t}</li>
                  ))}
                </ol>
              </Panel>
            </div>

            {/* Commit Feed */}
            <Panel title="Commit history">
              <div className="space-y-3 max-h-[55vh] overflow-auto pr-1">
                {commits.map((c, i) => (
                  <div key={c.planning_reference + i} className="border border-zinc-200 rounded-2xl p-4 bg-white hover:border-indigo-200 transition">
                    <div className="flex items-center justify-between">
                      <div className="font-semibold">{c.planning_reference}</div>
                      <div className="text-xs text-zinc-500">{String(c.event_dt).slice(0, 10)}</div>
                    </div>

                    <div className="mt-2 flex gap-2 flex-wrap">
                      <Badge>{c.normalised_application_type}</Badge>
                      <Badge tone={c.normalised_decision === "Approved" ? "green" : c.normalised_decision === "Refused" ? "red" : "gray"}>
                        {c.normalised_decision}
                      </Badge>
                    </div>

                    <div className="text-sm text-zinc-800 mt-2">
                      {c.heading || (c.proposal || "").slice(0, 160)}
                    </div>
                    <div className="text-xs text-zinc-500 mt-2 line-clamp-1">{c.raw_address}</div>

                    {c.url && (
                      <a className="text-sm text-indigo-600 hover:underline mt-2 inline-block" href={c.url} target="_blank">
                        Open portal ↗
                      </a>
                    )}
                  </div>
                ))}
              </div>
            </Panel>
          </section>

          {/* Assistant */}
          <aside className="rounded-3xl border border-zinc-200 bg-white shadow-sm p-5 flex flex-col">
            <div className="flex items-center gap-2 mb-3">
              <MessageSquare className="w-4 h-4 text-indigo-600" />
              <div className="font-semibold">Repo Assistant</div>
            </div>

            <div className="text-xs text-zinc-500 mb-3">
              Try: “Summarise what changed recently and what I should do next.”<br />
              Citations link to portal pages so you can verify.
            </div>

            <div className="flex gap-2 mb-3">
              <Quick onClick={() => ask("Summarise what changed recently and what I should do next.")}>What changed + next steps</Quick>
              <Quick onClick={() => ask("What is the latest decision and what does it imply?")}>Latest decision</Quick>
            </div>

            <div className="flex-1 overflow-auto space-y-3 pr-1">
              {chat.map((m: any, idx: number) => (
                <div key={idx} className={m.role === "user" ? "text-right" : "text-left"}>
                  <div className={`inline-block max-w-[95%] rounded-2xl px-3 py-2 text-sm ${
                    m.role === "user" ? "bg-indigo-600 text-white" : "bg-zinc-100 text-zinc-900"
                  }`}>
                    {m.text}
                  </div>

                  {m.role === "assistant" && m.citations?.length ? (
                    <div className="mt-2 space-y-1">
                      {m.citations.slice(0,4).map((c:any, j:number) => (
                        <a key={j} className="block text-[11px] text-zinc-600 hover:text-zinc-900 hover:underline"
                          href={c.url} target="_blank">
                          Source: {c.planning_reference}
                        </a>
                      ))}
                    </div>
                  ) : null}

                  {m.role === "assistant" ? (
                    <button onClick={() => speak(m.text)}
                      className="mt-2 text-xs text-zinc-600 hover:text-zinc-900 inline-flex items-center gap-1">
                      <Volume2 className="w-3 h-3" /> Read aloud
                    </button>
                  ) : null}
                </div>
              ))}
              {loading && <div className="text-sm text-zinc-600">Thinking…</div>}
            </div>

            <div className="mt-4 flex gap-2">
              <input
                className="flex-1 bg-zinc-50 border border-zinc-200 rounded-2xl px-3 py-2 outline-none"
                placeholder="Ask about this repo…"
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && question.trim()) ask(question.trim()); }}
              />
              <button onClick={() => question.trim() && ask(question.trim())}
                className="px-3 py-2 rounded-2xl bg-zinc-900 text-white font-medium">
                Ask
              </button>
              <button onClick={voiceAsk}
                className="px-3 py-2 rounded-2xl bg-indigo-600 text-white" title="Voice input (Chrome)">
                <Mic className="w-4 h-4" />
              </button>
            </div>
          </aside>
        </main>
      </div>
    </div>
  );
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-3xl border border-zinc-200 bg-white p-5 shadow-sm">
      <div className="text-sm font-semibold text-zinc-900 mb-3">{title}</div>
      {children}
    </div>
  );
}

function Kpi({ label, value }: { label: string; value: any }) {
  return (
    <div className="rounded-2xl border border-zinc-200 bg-white p-4 shadow-sm">
      <div className="text-xs text-zinc-500">{label}</div>
      <div className="text-sm font-semibold text-zinc-900 mt-1">{String(value)}</div>
    </div>
  );
}

function Badge({ children, tone="gray" }: { children: React.ReactNode; tone?: "gray"|"green"|"red" }) {
  const cls = tone === "green"
    ? "bg-emerald-50 text-emerald-700 border-emerald-200"
    : tone === "red"
    ? "bg-rose-50 text-rose-700 border-rose-200"
    : "bg-zinc-50 text-zinc-700 border-zinc-200";
  return <span className={`text-xs px-2 py-1 rounded-full border ${cls}`}>{children}</span>;
}

function Quick({ children, onClick }: { children: React.ReactNode; onClick: ()=>void }) {
  return (
    <button onClick={onClick} className="text-xs px-3 py-2 rounded-2xl border border-zinc-200 bg-zinc-50 hover:bg-zinc-100">
      {children}
    </button>
  );
}

function Chart({ data }: { data: {name: string, value: any}[] }) {
  if (!data?.length) return <div className="text-sm text-zinc-500">No data</div>;
  return (
    <div style={{ width: "100%", height: 240 }}>
      <ResponsiveContainer>
        <BarChart data={data}>
          <CartesianGrid strokeDasharray="3 3" />
          <XAxis dataKey="name" tick={{ fontSize: 10 }} interval={0} angle={-20} textAnchor="end" height={60} />
          <YAxis />
          <Tooltip />
          <Bar dataKey="value" />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}