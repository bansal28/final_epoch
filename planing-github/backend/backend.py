import os
import re
import difflib
import numpy as np
import pandas as pd
import requests

from fastapi import FastAPI, Query, HTTPException
from fastapi.responses import Response
from pathlib import Path
from sklearn.feature_extraction.text import TfidfVectorizer
from fastapi.middleware.cors import CORSMiddleware



# Optional Gemini
try:
    from google import genai
except Exception:
    genai = None

app = FastAPI(title="Planning GitHub Backend")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://127.0.0.1:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
@app.get("/")
def root():
    return {
        "name": "Planning GitHub API",
        "try": ["/health", "/docs", "/bundles?limit=3"]
    }
DATA_DIR = Path("data")
BUNDLES_PATH = DATA_DIR / "site_bundles.parquet"
REPO_PATH = DATA_DIR / "site_index_repo.parquet"

def die(msg: str):
    raise RuntimeError(msg)

def load_data():
    if not BUNDLES_PATH.exists():
        die(f"Missing {BUNDLES_PATH}. Put site_bundles.parquet in ./data")
    if not REPO_PATH.exists():
        die(f"Missing {REPO_PATH}. Put site_index_repo.parquet in ./data")

    bundles = pd.read_parquet(BUNDLES_PATH)
    repo = pd.read_parquet(REPO_PATH)

    # Hard schema checks
    for c in ["site_bundle_id","n_apps","council_name","sample_address","first_app","last_app"]:
        if c not in bundles.columns:
            die(f"bundles missing column: {c}")

    for c in ["site_bundle_id","planning_reference","event_dt","proposal","heading","url",
              "normalised_application_type","normalised_decision","raw_address"]:
        if c not in repo.columns:
            die(f"repo missing column: {c}")

    # Normalize types
    repo["event_dt"] = pd.to_datetime(repo["event_dt"], errors="coerce", utc=True)
    repo = repo.dropna(subset=["event_dt"]).copy()
    repo["proposal"] = repo["proposal"].fillna("").astype(str)
    repo["heading"] = repo["heading"].fillna("").astype(str)

    return bundles, repo

BUNDLES, REPO = load_data()

@app.get("/health")
def health():
    return {
        "ok": True,
        "bundles": int(len(BUNDLES)),
        "repo_rows": int(len(REPO)),
        "data_dir": str(DATA_DIR.resolve())
    }

@app.get("/bundles")
def list_bundles(
    council: str = Query("", description="Filter by council name (contains)"),
    q: str = Query("", description="Search in sample_address"),
    min_apps: int = Query(5, ge=1, le=1000),
    limit: int = Query(200, ge=10, le=2000)
):
    b = BUNDLES.copy()

    if council.strip():
        b = b[b["council_name"].fillna("").str.contains(council, case=False, na=False)]
    if q.strip():
        b = b[b["sample_address"].fillna("").str.contains(q, case=False, na=False)]

    b = b[b["n_apps"] >= min_apps].sort_values("n_apps", ascending=False).head(limit)
    return b.to_dict(orient="records")

@app.get("/repo/{bundle_id}")
def repo_detail(bundle_id: str):
    r = REPO[REPO["site_bundle_id"] == bundle_id].copy()
    if r.empty:
        raise HTTPException(404, "bundle not found")
    r = r.sort_values("event_dt")
    cols = [
        "planning_reference","event_dt","normalised_application_type","normalised_decision",
        "heading","proposal","raw_address","url"
    ]
    cols = [c for c in cols if c in r.columns]
    return {"bundle_id": bundle_id, "commits": r[cols].to_dict(orient="records")}

@app.get("/repo/{bundle_id}/diff")
def repo_diff(bundle_id: str, a: str, b: str):
    r = REPO[REPO["site_bundle_id"] == bundle_id]
    if r.empty:
        raise HTTPException(404, "bundle not found")

    ra = r[r["planning_reference"] == a]
    rb = r[r["planning_reference"] == b]
    if ra.empty or rb.empty:
        raise HTTPException(404, "commit not found")

    ta = (ra.iloc[0].get("proposal","") or "")[:2500]
    tb = (rb.iloc[0].get("proposal","") or "")[:2500]

    diff = list(difflib.unified_diff(ta.splitlines(), tb.splitlines(), lineterm=""))
    return {"a": a, "b": b, "diff": diff[:500]}

def retrieve_commits(repo_rows, query: str, k=6):
    texts = []
    meta = []
    for r in repo_rows:
        t = f"{r.get('planning_reference','')} | {r.get('normalised_application_type','')} | {r.get('normalised_decision','')}\n"
        t += (r.get("heading","") or "") + "\n"
        t += (r.get("proposal","") or "")
        texts.append(t)
        meta.append(r)

    vec = TfidfVectorizer(ngram_range=(1,2), min_df=1, max_features=30000)
    X = vec.fit_transform(texts + [query])
    sims = (X[:-1] @ X[-1].T).toarray().ravel()
    top = np.argsort(-sims)[:k]
    return [meta[i] for i in top]

def gemini_answer(question: str, ctx_rows):
    api_key = os.getenv("GEMINI_API_KEY", "")
    if not api_key or genai is None:
        # fallback (still demoable)
        bullets = []
        for r in ctx_rows:
            msg = (r.get("heading") or r.get("proposal") or "")[:140]
            bullets.append(f"- {r.get('planning_reference')} ({r.get('normalised_application_type')}, {r.get('normalised_decision')}): {msg}")
        return {
            "answer": "Gemini not configured. Here are the most relevant commits:\n" + "\n".join(bullets),
            "citations": [{"planning_reference": r.get("planning_reference"), "url": r.get("url")} for r in ctx_rows]
        }

    client = genai.Client(api_key=api_key)
    model = os.getenv("GEMINI_MODEL", "gemini-2.5-flash")

    context_block = "\n\n".join([
        f"[{i+1}] REF={r.get('planning_reference')} TYPE={r.get('normalised_application_type')} DECISION={r.get('normalised_decision')}\n"
        f"HEADING: {r.get('heading','')}\n"
        f"PROPOSAL: {r.get('proposal','')}\n"
        f"URL: {r.get('url','')}\n"
        for i, r in enumerate(ctx_rows)
    ])

    prompt = f"""
Answer ONLY using the context.
Cite facts with [1], [2]...
If context is insufficient, say so.

QUESTION:
{question}

CONTEXT:
{context_block}
""".strip()

    resp = client.models.generate_content(model=model, contents=prompt)
    answer_text = getattr(resp, "text", None) or str(resp)

    return {
        "answer": answer_text,
        "citations": [{"planning_reference": r.get("planning_reference"), "url": r.get("url")} for r in ctx_rows]
    }

@app.post("/chat")
def chat(payload: dict):
    bundle_id = (payload.get("bundle_id") or "").strip()
    question = (payload.get("question") or "").strip()
    if not bundle_id or not question:
        raise HTTPException(400, "bundle_id and question required")

    r = REPO[REPO["site_bundle_id"] == bundle_id].copy()
    if r.empty:
        raise HTTPException(404, "bundle not found")

    rows = r.sort_values("event_dt").to_dict(orient="records")
    ctx = retrieve_commits(rows, question, k=6)
    base = repo_overview(bundle_id)

    ans = gemini_answer(question, ctx)
    ans["overview"] = base  # add actionable context
    return ans

@app.post("/tts")
def tts(payload: dict):
    text = (payload.get("text") or "").strip()
    if not text:
        raise HTTPException(400, "text required")

    api_key = os.getenv("ELEVEN_API_KEY", "")
    voice_id = os.getenv("ELEVEN_VOICE_ID", "")
    if not api_key or not voice_id:
        raise HTTPException(400, "ELEVEN_API_KEY and ELEVEN_VOICE_ID must be set")

    url = f"https://api.elevenlabs.io/v1/text-to-speech/{voice_id}/stream"
    headers = {"xi-api-key": api_key, "Content-Type": "application/json", "Accept": "audio/mpeg"}
    payload = {
        "text": text,
        "model_id": os.getenv("ELEVEN_MODEL_ID", "eleven_multilingual_v2"),
        "output_format": "mp3_44100_128"
    }

    r = requests.post(url, headers=headers, json=payload, timeout=60)
    r.raise_for_status()
    return Response(content=r.content, media_type="audio/mpeg")
def repo_overview(bundle_id: str):
    r = REPO[REPO["site_bundle_id"] == bundle_id].copy()
    if r.empty:
        raise HTTPException(404, "bundle not found")
    r = r.sort_values("event_dt")

    # Type buckets (simple, explainable)
    t = r["normalised_application_type"].fillna("").str.lower()
    is_main = t.str.contains("full planning|householder|listed building consent|prior approval", regex=True)
    is_amend = t.str.contains("non-material amendment|variation of conditions|minor amendment", regex=True)
    is_cond = t.str.contains("discharge of conditions|details pursuant|condition", regex=True)

    main_count = int(is_main.sum())
    amend_count = int(is_amend.sum())
    cond_count = int(is_cond.sum())

    # Decision breakdown
    dec = r["normalised_decision"].fillna("Unknown")
    decision_counts = dec.value_counts().to_dict()

    # Timeline
    first_dt = r["event_dt"].min()
    last_dt = r["event_dt"].max()
    days_span = int((last_dt - first_dt).days) if pd.notna(first_dt) and pd.notna(last_dt) else None

    # Simple “stage”
    stage = "Unknown"
    if (dec.str.lower() == "approved").any() and cond_count > 0:
        stage = "Post-permission delivery (conditions/discharges)"
    elif amend_count > 0:
        stage = "Design iteration (amendments)"
    else:
        stage = "Application phase"

    churn_score = float(amend_count / max(len(r), 1))
    condition_debt = float(cond_count / max(1, (dec.str.lower() == "approved").sum()))

    # Actionable insights for a developer
    insights = []
    next_actions = []

    if stage.startswith("Post-permission"):
        insights.append("This repo is dominated by condition discharge activity: delivery risk is in post-permission compliance, not initial approval.")
        next_actions.append("Create a condition tracker: list each condition number/topic, responsible consultant, and submission status.")
        next_actions.append("Batch submissions: councils respond better to complete packs (e.g., drainage + materials + ecology together).")

    if amend_count >= 3:
        insights.append("High amendment churn detected: repeated changes increase timeline and coordination risk.")
        next_actions.append("Freeze the design baseline and only submit amendments as a bundled change-set (avoid drip-feeding).")

    if decision_counts.get("Withdrawn", 0) >= 1:
        insights.append("Withdrawals present: indicates negotiation/refinement cycles rather than clean approvals/refusals.")
        next_actions.append("Review officer feedback on withdrawn items; resubmit with explicit responses mapped to policy points.")

    # Surface “what happened last”
    latest = r.iloc[-1].to_dict()
    latest_summary = {
        "planning_reference": latest.get("planning_reference"),
        "date": str(latest.get("event_dt"))[:10],
        "type": latest.get("normalised_application_type"),
        "decision": latest.get("normalised_decision"),
        "heading": (latest.get("heading") or latest.get("proposal") or "")[:140],
        "url": latest.get("url")
    }

    type_counts = r["normalised_application_type"].fillna("Unknown").value_counts().head(8).to_dict()

    return {
        "bundle_id": bundle_id,
        "n_commits": int(len(r)),
        "stage": stage,
        "days_span": days_span,
        "main_count": main_count,
        "amend_count": amend_count,
        "cond_count": cond_count,
        "churn_score": round(churn_score, 3),
        "condition_debt": round(condition_debt, 3),
        "decision_counts": decision_counts,
        "type_counts": type_counts,
        "latest": latest_summary,
        "insights": insights[:5],
        "next_actions": next_actions[:6],
    }

@app.get("/repo/{bundle_id}/overview")
def repo_overview_endpoint(bundle_id: str):
    return repo_overview(bundle_id)