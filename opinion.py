"""
AI valuation opinions: fan out a stock's data to N LLM "agents", then a
summarizer condenses their responses. Provider-agnostic so new LLMs (OpenAI,
Gemini, open-weight, ...) can be plugged in by adding a Provider + a profile.

Flow: start_job() spawns a background thread -> agents run in parallel ->
summarizer -> result saved to data/opinions/<SYM>/<ts>.json. Poll status(job_id)
for progress; list_opinions()/get_opinion() read saved results.
"""

import json
import os
import re
import shutil
import subprocess
import tempfile
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime

HERE = os.path.dirname(os.path.abspath(__file__))
PROMPT_DIR = os.path.join(HERE, "prompts")
OPINION_DIR = os.path.join(HERE, "data", "opinions")

AGENT_MAX_TOKENS = 8000
SUMMARY_MAX_TOKENS = 4000

# ---------------------------------------------------------------------------
# Providers — pluggable LLM backends. complete() is plain text-in / text-out so
# any model works; the JSON+freetext contract is enforced purely by the prompt.
# ---------------------------------------------------------------------------

class MockProvider:
    """No API key needed — canned JSON+freetext for testing the pipeline."""
    name = "mock"

    def complete(self, system, user, model, research, max_tokens, thinking=False):
        import random
        time.sleep(0.4)
        iv = round(random.uniform(80, 320), 2)
        js = {
            "verdict": random.choice(["buy", "hold", "avoid"]),
            "quality_gate_pass": random.choice([True, False]),
            "primary_method": random.choice(["DCF", "EPV", "reverse_DCF", "relative"]),
            "intrinsic_value": iv, "buy_below": round(iv * 0.75, 2), "fair_value": iv,
            "confidence": round(random.uniform(0.3, 0.9), 2),
            "key_assumptions": ["mock assumption"], "key_risks": ["mock risk"],
            "recent_news_flags": ["(mock provider — no web access)"],
        }
        return ("```json\n" + json.dumps(js, indent=2) + "\n```\n\n"
                "Mock rationale: stub response from the mock provider, used to "
                "exercise the orchestration without calling a real model.\n")


CLI_TIMEOUT = 600   # seconds per CLI call


class CLIProvider:
    """Base for providers that shell out to a vendor CLI — runs on your own
    subscription, no API billing. Add a new CLI (Gemini, Codex, …) by
    subclassing: set name/binary/env_var/models and override argv()."""
    name = "cli"
    binary = "cli"
    env_var = None        # optional env var to override the binary path
    models = {}           # full model id -> CLI alias

    def bin(self):
        return (self.env_var and os.environ.get(self.env_var)) or self.binary

    def argv(self, binary, model, system, user, research):
        raise NotImplementedError

    def complete(self, system, user, model, research, max_tokens, thinking=False):
        argv = self.argv(self.bin(), self.models.get(model, model), system, user, research)
        res = subprocess.run(argv, capture_output=True, text=True, timeout=CLI_TIMEOUT)
        if res.returncode != 0:
            raise RuntimeError((res.stderr or res.stdout or "cli failed").strip()[:500])
        return res.stdout.strip()


class ClaudeCLIProvider(CLIProvider):
    """Local `claude` CLI in print mode. Research = the CLI's WebSearch tool."""
    name = "claude"
    binary = "claude"
    env_var = "CLAUDE_CLI"
    models = {"claude-haiku-4-5": "haiku", "claude-sonnet-4-6": "sonnet",
              "claude-opus-4-8": "opus", "claude-opus-4-7": "opus"}

    def argv(self, binary, model, system, user, research):
        cmd = [binary, "-p", user, "--model", model, "--output-format", "text"]
        if system:
            cmd += ["--append-system-prompt", system]
        if research:
            cmd += ["--allowedTools", "WebSearch"]
        return cmd


class GeminiCLIProvider(CLIProvider):
    """Google Gemini via the Antigravity CLI (`agy`) in --print mode. No
    system-prompt flag, so the system prompt is folded into the user prompt.
    Runs --sandbox (restricted terminal); research adds
    --dangerously-skip-permissions so its tools (incl. web) run without
    prompting. Model strings are agy's display names (see `agy models`)."""
    name = "gemini"
    binary = "agy"
    env_var = "AGY_CLI"
    models = {"gemini-3.1-pro": "Gemini 3.1 Pro (High)",
              "gemini-3.5-flash": "Gemini 3.5 Flash (High)"}

    def argv(self, binary, model, system, user, research):
        prompt = (system + "\n\n" + user) if system else user
        cmd = [binary, "--model", model, "--sandbox", "--print-timeout", "9m"]
        if research:
            cmd.append("--dangerously-skip-permissions")
        cmd += ["--print", prompt]
        return cmd


class CodexCLIProvider(CLIProvider):
    """Local `codex` (ChatGPT) CLI in non-interactive `exec` mode. Codex streams
    events to stdout, so we capture the clean final message via -o <file>. No
    system-prompt flag → folded into the prompt. read-only sandbox; web_search
    enabled when research is on. NOTE: with a ChatGPT (non-API) login only the
    models your plan allows will work — adjust `models`/profile if you get a
    'model is not supported … with a ChatGPT account' error."""
    name = "chatgpt"
    binary = "codex"
    env_var = "CODEX_CLI"
    models = {"gpt-5.5": "gpt-5.5", "gpt-5.1": "gpt-5.1"}

    def complete(self, system, user, model, research, max_tokens, thinking=False):
        prompt = (system + "\n\n" + user) if system else user
        fd, out_path = tempfile.mkstemp(suffix=".txt"); os.close(fd)
        try:
            cmd = [self.bin(), "exec", "--skip-git-repo-check",
                   "--sandbox", "read-only", "--color", "never",
                   "-m", self.models.get(model, model), "-o", out_path]
            if research:
                cmd += ["-c", "tools.web_search=true"]
            cmd.append(prompt)
            res = subprocess.run(cmd, capture_output=True, text=True, timeout=CLI_TIMEOUT)
            try:
                with open(out_path) as fh:
                    out = fh.read().strip()
            except OSError:
                out = ""
            if not out:
                if res.returncode != 0:
                    raise RuntimeError((res.stderr or res.stdout or "codex failed").strip()[:500])
                out = res.stdout.strip()
            return out
        finally:
            try:
                os.unlink(out_path)
            except OSError:
                pass


CLI_PROVIDERS = [ClaudeCLIProvider(), CodexCLIProvider(), GeminiCLIProvider()]


PROVIDERS = {}
def register(p): PROVIDERS[p.name] = p

register(MockProvider())
for _p in CLI_PROVIDERS:
    if shutil.which(_p.bin()):
        register(_p)

# ---------------------------------------------------------------------------
# Profiles — which providers/models run, how many agents, and research on/off.
# ACTIVE_PROFILE is the default; pass ?profile=... to override per request.
# ---------------------------------------------------------------------------

PROFILES = {
    # pipeline testing without any API key
    "mock": {
        "agents": [{"provider": "mock", "model": "mock-1"},
                   {"provider": "mock", "model": "mock-2"}],
        "summary": {"provider": "mock", "model": "mock-sum"},
        "research": False, "thinking": False,
    },
    # go-fast: smallest model, no web research, no thinking — returns quickly
    "fast": {
        "agents": [{"provider": "claude", "model": "claude-haiku-4-5"},
                   {"provider": "claude", "model": "claude-haiku-4-5"}],
        "summary": {"provider": "claude", "model": "claude-haiku-4-5"},
        "research": False, "thinking": False,
    },
    # production: 3x3 + summarizer — claude + chatgpt + gemini, three agents
    # each, web research + thinking.
    "full": {
        "agents": [{"provider": "claude", "model": "claude-opus-4-8"},
                   {"provider": "claude", "model": "claude-opus-4-8"},
                   {"provider": "claude", "model": "claude-opus-4-8"},
                   {"provider": "chatgpt", "model": "gpt-5.5"},
                   {"provider": "chatgpt", "model": "gpt-5.5"},
                   {"provider": "chatgpt", "model": "gpt-5.5"},
                   {"provider": "gemini", "model": "gemini-3.1-pro"},
                   {"provider": "gemini", "model": "gemini-3.1-pro"},
                   {"provider": "gemini", "model": "gemini-3.1-pro"}],
        "summary": {"provider": "claude", "model": "claude-opus-4-8"},
        "research": True, "thinking": True,
    },
}
ACTIVE_PROFILE = "full"   # "mock"/"fast" for testing, "full" for production

# ---------------------------------------------------------------------------
# Job orchestration
# ---------------------------------------------------------------------------

_jobs = {}            # job_id -> job dict (in-memory; results also persisted)
_lock = threading.Lock()


def _load_prompt(name):
    with open(os.path.join(PROMPT_DIR, name)) as fh:
        return fh.read()


def _extract_json(text):
    if not text:
        return None
    m = re.search(r"```json\s*(.*?)```", text, re.S) or re.search(r"```\s*(\{.*?\})\s*```", text, re.S)
    if m:
        try:
            return json.loads(m.group(1))
        except Exception:
            return None
    return None


def _agent_user_msg(symbol, data):
    return (f"Valuation request for {symbol}.\n\n"
            f"Available data (JSON):\n{json.dumps(data, indent=2, default=str)}\n\n"
            f"Produce your valuation and opinion following your instructions.")


def _summary_user_msg(symbol, runs):
    parts = [f"Stock: {symbol}", f"{len(runs)} independent analyses follow "
             "(some may have failed).", ""]
    for r in runs:
        parts.append(f"### Analysis {r['i'] + 1} — {r['provider']}:{r['model']}")
        if r.get("error"):
            parts.append(f"FAILED: {r['error']}")
        else:
            parts.append("Structured verdict: " + json.dumps(r.get("structured"), default=str))
            parts.append("Rationale:\n" + (r.get("freetext") or "")[:6000])
        parts.append("")
    parts.append("Now synthesize these into one briefing per your instructions.")
    return "\n".join(parts)


def _public(job):
    return {k: job[k] for k in
            ("id", "symbol", "ts", "profile", "state", "agents", "summary",
             "log", "runs", "summary_md")}


def _save(job):
    d = os.path.join(OPINION_DIR, job["symbol"].upper())
    os.makedirs(d, exist_ok=True)
    path = os.path.join(d, job["ts"] + ".json")
    tmp = path + ".tmp"
    with open(tmp, "w") as fh:
        json.dump(_public(job), fh)
    os.replace(tmp, path)


def _run_job(job):
    prof = PROFILES[job["profile"]]
    sym, data = job["symbol"], job["data"]
    research, thinking = prof.get("research", False), prof.get("thinking", False)

    def log(msg):
        job["log"].append(f"{datetime.now():%H:%M:%S}  {msg}")

    job["state"] = "running"
    log(f"started · profile={job['profile']} · {len(prof['agents'])} agents · research={research}")
    agent_system = _load_prompt("opinion_agent.md")

    def worker(i, spec):
        a = job["agents"][i]
        a["status"] = "running"
        log(f"agent {i + 1} ({spec['provider']}:{spec['model']}) running…")
        try:
            t0 = time.time()
            text = PROVIDERS[spec["provider"]].complete(
                system=agent_system, user=_agent_user_msg(sym, data),
                model=spec["model"], research=research, max_tokens=AGENT_MAX_TOKENS,
                thinking=thinking)
            a["status"] = "done"
            log(f"agent {i + 1} done ({round(time.time() - t0, 1)}s)")
            struct = _extract_json(text)
            free = re.sub(r"```json\s*.*?```", "", text, count=1, flags=re.S).strip() if struct else text
            return {"i": i, "provider": spec["provider"], "model": spec["model"],
                    "raw": text, "structured": struct, "freetext": free,
                    "latency": round(time.time() - t0, 1), "error": None}
        except Exception as e:
            a["status"], a["error"] = "error", str(e)
            log(f"agent {i + 1} FAILED: {e}")
            return {"i": i, "provider": spec["provider"], "model": spec["model"],
                    "raw": None, "structured": None, "freetext": None,
                    "latency": None, "error": str(e)}

    specs = list(enumerate(prof["agents"]))
    with ThreadPoolExecutor(max_workers=max(1, len(specs))) as ex:   # fire all at once
        runs = list(ex.map(lambda t: worker(*t), specs))
    runs.sort(key=lambda r: r["i"])
    job["runs"] = runs
    ok = [r for r in runs if r.get("error") is None]
    log(f"agents complete: {len(ok)}/{len(runs)} succeeded")

    if ok:
        try:
            ss = prof["summary"]
            log(f"summarizing ({ss['provider']}:{ss['model']})…")
            job["summary"]["status"] = "running"
            job["summary_md"] = PROVIDERS[ss["provider"]].complete(
                system=_load_prompt("opinion_summary.md"),
                user=_summary_user_msg(sym, runs),
                model=ss["model"], research=False, max_tokens=SUMMARY_MAX_TOKENS,
                thinking=thinking)
            job["summary"]["status"] = "done"
            log("summary done")
        except Exception as e:
            job["summary_md"] = f"_Summary failed: {e}_"
            job["summary"]["status"] = "error"
            job["summary"]["error"] = str(e)
            log(f"summary FAILED: {e}")
    else:
        job["summary_md"] = "_All analyses failed — no summary._"
        job["summary"]["status"] = "skipped"

    job["state"] = "done"
    try:
        _save(job)
        log("saved")
    except Exception as e:
        log(f"save FAILED: {e}")


def start_job(symbol, data, profile=None):
    profile = profile if profile in PROFILES else ACTIVE_PROFILE
    prof = PROFILES[profile]
    job = {
        "id": uuid.uuid4().hex[:12],
        "symbol": symbol.upper(),
        "ts": datetime.now().strftime("%Y-%m-%dT%H-%M-%S"),
        "profile": profile,
        "state": "queued",
        "agents": [{"i": i, "provider": a["provider"], "model": a["model"],
                    "status": "pending", "error": None}
                   for i, a in enumerate(prof["agents"])],
        "summary": {"provider": prof["summary"]["provider"],
                    "model": prof["summary"]["model"],
                    "status": "pending", "error": None},
        "log": [], "runs": [], "summary_md": None,
        "data": data,
    }
    with _lock:
        _jobs[job["id"]] = job
    threading.Thread(target=_run_job, args=(job,), daemon=True).start()
    return {"id": job["id"], "ts": job["ts"], "symbol": job["symbol"],
            "profile": profile, "state": "queued"}


def status(job_id):
    job = _jobs.get(job_id)
    return _public(job) if job else None


def list_opinions(symbol):
    d = os.path.join(OPINION_DIR, symbol.upper())
    out = []
    if os.path.isdir(d):
        for f in sorted(os.listdir(d), reverse=True):
            if f.endswith(".json"):
                out.append({"id": f[:-5], "ts": f[:-5]})
    return out


def get_opinion(symbol, oid):
    path = os.path.join(OPINION_DIR, symbol.upper(), oid + ".json")
    if not os.path.exists(path):
        return None
    with open(path) as fh:
        return json.load(fh)


def delete_opinion(symbol, oid):
    """Remove one saved run. oid is a timestamp id; basename-guarded against
    path traversal. Prunes the symbol dir if it becomes empty. Returns True if
    a file was deleted."""
    oid = os.path.basename(oid)
    d = os.path.join(OPINION_DIR, symbol.upper())
    path = os.path.join(d, oid + ".json")
    if not os.path.exists(path):
        return False
    os.remove(path)
    try:
        if not os.listdir(d):
            os.rmdir(d)
    except OSError:
        pass
    return True
