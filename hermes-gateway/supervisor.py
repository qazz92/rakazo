#!/usr/bin/env python3
"""Rakazo supervisor: polls provisioning commands and drives the hermes CLI.
Outbound-only: this process dials out to Rakazo; no inbound ports."""
import json
import os
import re
import subprocess
import sys
import time

import httpx
import yaml

PROFILES_DIR = os.path.expanduser("~/.hermes/profiles")
A2A_BASE_PORT = 9900  # hermes default; reserved, rakazo profiles start at 9901
API = os.environ.get("RAKAZO_URL", "").rstrip("/")
DEPLOY_TOKEN = os.environ.get("RAKAZO_DEPLOY_TOKEN", "")
TEMPLATE = os.environ.get("RAKAZO_TEMPLATE_PROFILE", "rakazo-template")
NAME_RE = re.compile(r"^[a-z0-9-]+$")


def sh(*args: str) -> subprocess.CompletedProcess:
    return subprocess.run(args, capture_output=True, text=True)


def set_env_line(path: str, key: str, value: str) -> None:
    """Replace (or append) one KEY=value line in a profile .env."""
    lines = open(path).read().splitlines() if os.path.exists(path) else []
    pattern = re.compile(rf"^{key}=.*$")
    out, seen = [], False
    for line in lines:
        if pattern.match(line):
            out.append(f"{key}={value}")
            seen = True
        else:
            out.append(line)
    if not seen:
        out.append(f"{key}={value}")
    with open(path, "w") as f:
        f.write("\n".join(out) + "\n")


def load_config(path: str):
    """config.yaml -> dict. Missing/empty -> {}. Unparseable -> None (skip profile)."""
    if not os.path.exists(path):
        return {}
    try:
        with open(path) as f:
            cfg = yaml.safe_load(f)
    except yaml.YAMLError as exc:
        print(f"[rakazo-supervisor] config parse error {path}: {exc}", file=sys.stderr)
        return None
    return cfg if isinstance(cfg, dict) else ({} if cfg is None else None)


def rakazo_profile_names(profiles_dir: str) -> list:
    if not os.path.isdir(profiles_dir):
        return []
    return sorted(
        d for d in os.listdir(profiles_dir)
        if d.startswith("rakazo-") and os.path.isdir(os.path.join(profiles_dir, d))
    )


def allocate_ports(cfgs: dict) -> dict:
    """name -> a2a port. Reuse the port already written in each profile's
    config.yaml (first come, sorted order); others get the next free from
    9901 upward. 9900 is never handed out."""
    ports, used, pending = {}, set(), []
    for name, cfg in cfgs.items():
        platforms = cfg.get("platforms") or {}
        port = (platforms.get("a2a") or {}).get("port") if isinstance(platforms, dict) else None
        if isinstance(port, int) and port not in used:
            ports[name] = port
            used.add(port)
        else:
            pending.append(name)
    nxt = A2A_BASE_PORT + 1
    for name in pending:
        while nxt in used:
            nxt += 1
        ports[name] = nxt
        used.add(nxt)
        nxt += 1
    return ports


def sync_a2a_roster(profiles_dir: str = PROFILES_DIR) -> bool:
    """Re-sync the a2a roster across every rakazo-* profile.

    a2a peers are NOT auto-discovered, so the supervisor owns this: each
    rakazo profile gets a stable 99xx port in config.yaml platforms.a2a.port
    (its gateway binds it from next start) and an a2a_agents section listing
    every OTHER rakazo profile as http://127.0.0.1:<port>. The roster is
    loaded fresh per a2a_call, so no gateway restarts are needed for peer
    updates — only the owning profile restarts when its own port changes.
    Returns False only on an unexpected top-level failure; per-profile
    problems (unparseable config.yaml) are skipped and logged.
    """
    try:
        cfgs = {}
        for name in rakazo_profile_names(profiles_dir):
            cfg = load_config(os.path.join(profiles_dir, name, "config.yaml"))
            if cfg is None:
                print(f"[rakazo-supervisor] roster sync: skipping {name} (config.yaml unreadable)", file=sys.stderr)
                continue
            cfgs[name] = cfg
        ports = allocate_ports(cfgs)
        for name, cfg in cfgs.items():
            platforms = cfg.get("platforms")
            if not isinstance(platforms, dict):
                platforms = {}
                cfg["platforms"] = platforms
            a2a = platforms.get("a2a")
            if not isinstance(a2a, dict):
                a2a = {}
                platforms["a2a"] = a2a
            a2a["port"] = ports[name]
            cfg["a2a_agents"] = {
                peer: {"url": f"http://127.0.0.1:{ports[peer]}"}
                for peer in sorted(cfgs)
                if peer != name
            }
            with open(os.path.join(profiles_dir, name, "config.yaml"), "w") as f:
                yaml.safe_dump(cfg, f, sort_keys=False)
        return True
    except Exception as exc:  # ponytail: roster sync must never kill the loop
        print(f"[rakazo-supervisor] a2a roster sync failed: {exc}", file=sys.stderr)
        return False


def provision(cmd: dict) -> tuple:
    name, payload = cmd["payload"]["name"], cmd["payload"]
    if not NAME_RE.match(name):
        return False, f"invalid profile name {name!r}"
    profile_env = os.path.expanduser(f"~/.hermes/profiles/{name}/.env")
    soul = os.path.expanduser(f"~/.hermes/profiles/{name}/SOUL.md")
    r = sh("hermes", "profile", "create", name, "--clone-from", TEMPLATE)
    if r.returncode != 0:
        return False, f"profile create failed: {r.stderr.strip()[:300]}"
    with open(profile_env, "a") as f:
        f.write(f"\nRAKAZO_URL={API}\nRAKAZO_TOKEN={payload['token']}\nRAKAZO_HOME_CHANNEL={payload['threadId']}\n")
    # 로컬 E2E 실측 3요소 (2026-09-05):
    # 1) profile 게이트웨이는 HERMES_HOME(=프로파일 루트) plugins/만 탐색한다 — 전역
    #    ~/.hermes/plugins가 아니므로 플러그인을 프로파일에 복사해야 한다.
    plugin_dir = os.path.dirname(os.path.abspath(__file__))
    plugin_dst_dir = os.path.expanduser(f"~/.hermes/profiles/{name}/plugins/rakazo")
    try:
        os.makedirs(plugin_dst_dir, exist_ok=True)
        for fname in ("plugin.yaml", "adapter.py", "__init__.py"):
            src = os.path.join(plugin_dir, fname)
            if os.path.exists(src):
                with open(src) as fin, open(os.path.join(plugin_dst_dir, fname), "w") as fout:
                    fout.write(fin.read())
    except OSError as exc:
        return False, f"plugin copy failed: {exc}"
    # 2) 플러그인 디스커버리는 plugins.enabled allow-list(옵트인) 게이트를 통과해야 한다.
    # 3) hermes authz는 user_id 없는 인바운드를 정책과 무관하게 기각한다 — 어댑터가
    #    threadId를 user_id로 싣고, 채널 인가는 api의 bearer 게이트가 이미 끝났으므로
    #    프로파일에서 allow-all로 연다.
    profile_cfg_path = os.path.expanduser(f"~/.hermes/profiles/{name}/config.yaml")
    cfg = load_config(profile_cfg_path)
    if cfg is None:
        return False, f"config parse error: {profile_cfg_path}"
    enabled = (cfg.get("plugins") or {}).get("enabled")
    if not isinstance(enabled, list):
        enabled = []
    if "rakazo" not in enabled:
        enabled.append("rakazo")
        cfg.setdefault("plugins", {})["enabled"] = enabled
        with open(profile_cfg_path, "w") as f:
            yaml.safe_dump(cfg, f, sort_keys=False)
    set_env_line(profile_env, "GATEWAY_ALLOW_ALL_USERS", "true")
    # Allocate the a2a port + roster BEFORE first gateway start so the a2a
    # server binds it from the very first run (profile-scoped a2a ignores
    # A2A_PORT env and reads platforms.a2a.port from config.yaml).
    if not sync_a2a_roster():
        return False, "a2a roster sync failed (profile created; retry provision or fix ~/.hermes/profiles)"
    for args in (("hermes", "-p", name, "gateway", "install"), ("hermes", "-p", name, "gateway", "start")):
        r = sh(*args)
        if r.returncode != 0:
            return False, f"{' '.join(args)} failed: {r.stderr.strip()[:300]}"
    return True, "provisioned"


def deprovision(cmd: dict) -> tuple:
    name = cmd["payload"]["name"]
    if not NAME_RE.match(name):
        return False, f"invalid profile name {name!r}"
    sh("hermes", "-p", name, "gateway", "stop")
    r = sh("hermes", "profile", "delete", name, "-y")  # 소스 검증: -y 없으면 confirmation 프롬프트에서 블록
    ok = r.returncode == 0
    detail = r.stderr.strip()[:300] or "deprovisioned"
    # Drop the dead peer from every remaining profile's roster.
    if ok and not sync_a2a_roster():
        return True, f"{detail} (a2a roster sync failed; peers still list this profile)"
    return ok, detail


def update(cmd: dict) -> tuple:
    """Persona edit and/or token rotation. Gateway restart so a new session
    picks up the new SOUL/env (소스 검증: `gateway restart` 실존)."""
    name, payload = cmd["payload"]["name"], cmd["payload"]
    if not NAME_RE.match(name):
        return False, f"invalid profile name {name!r}"
    profile_env = os.path.expanduser(f"~/.hermes/profiles/{name}/.env")
    if not os.path.isdir(os.path.dirname(profile_env)):
        return False, "profile does not exist"
    if payload.get("token"):
        set_env_line(profile_env, "RAKAZO_TOKEN", payload["token"])
    if payload.get("soul") is not None:
        with open(os.path.expanduser(f"~/.hermes/profiles/{name}/SOUL.md"), "w") as f:
            f.write(payload["soul"] or "You are a Rakazo bot.\n")
    r = sh("hermes", "-p", name, "gateway", "restart")
    if r.returncode != 0:
        return False, f"gateway restart failed: {r.stderr.strip()[:300]}"
    return True, "updated"


def lifecycle(action: str):
    def handler(cmd: dict) -> tuple:
        name = cmd["payload"]["name"]
        if not NAME_RE.match(name):
            return False, f"invalid profile name {name!r}"
        r = sh("hermes", "-p", name, "gateway", action)
        return (r.returncode == 0, r.stderr.strip()[:300] or action)
    return handler


HANDLERS = {
    "provision": provision,
    "update": update,
    "stop": lifecycle("stop"),
    "start": lifecycle("start"),
    "deprovision": deprovision,
}


def selftest() -> int:
    """Exercise the pure helpers against temp dirs. No network, no hermes, no ~/.hermes."""
    import tempfile

    with tempfile.TemporaryDirectory() as tmp:
        profiles = os.path.join(tmp, "profiles")
        # a: existing config with a written port + unrelated keys
        os.makedirs(os.path.join(profiles, "rakazo-a"))
        with open(os.path.join(profiles, "rakazo-a", "config.yaml"), "w") as f:
            yaml.safe_dump({"model": "gpt", "platforms": {"a2a": {"port": 9905}}, "other": [1, 2]}, f)
        # b: fresh profile, no config.yaml
        os.makedirs(os.path.join(profiles, "rakazo-b"))
        # personal: non-rakazo profile — must never be touched
        os.makedirs(os.path.join(profiles, "personal"))
        open(os.path.join(profiles, "personal", "config.yaml"), "w").write("untouched: yes\n")
        # bad: unparseable config — must be skipped without killing the sync
        os.makedirs(os.path.join(profiles, "rakazo-bad"))
        open(os.path.join(profiles, "rakazo-bad", "config.yaml"), "w").write("*undefined_alias\n")

        assert sync_a2a_roster(profiles), "sync failed"
        a = load_config(os.path.join(profiles, "rakazo-a", "config.yaml"))
        b = load_config(os.path.join(profiles, "rakazo-b", "config.yaml"))
        assert a["platforms"]["a2a"]["port"] == 9905, a  # reuse written port
        assert b["platforms"]["a2a"]["port"] == 9901, b  # fresh starts at 9901, skips 9900
        assert a["a2a_agents"] == {"rakazo-b": {"url": "http://127.0.0.1:9901"}}, a
        assert b["a2a_agents"] == {"rakazo-a": {"url": "http://127.0.0.1:9905"}}, b  # roster excludes self + bad
        assert a["model"] == "gpt" and a["other"] == [1, 2], a  # round-trip preserves other keys
        assert open(os.path.join(profiles, "personal", "config.yaml")).read() == "untouched: yes\n"
        assert load_config(os.path.join(profiles, "rakazo-bad", "config.yaml")) is None  # skipped, not rewritten
        print("PASS sync_a2a_roster: ports, roster, exclusions, round-trip")

        # stability: re-sync must keep both ports (no churn)
        assert sync_a2a_roster(profiles)
        assert load_config(os.path.join(profiles, "rakazo-a", "config.yaml"))["platforms"]["a2a"]["port"] == 9905
        assert load_config(os.path.join(profiles, "rakazo-b", "config.yaml"))["platforms"]["a2a"]["port"] == 9901
        # a third fresh profile takes the next free slot
        os.makedirs(os.path.join(profiles, "rakazo-c"))
        assert sync_a2a_roster(profiles)
        c = load_config(os.path.join(profiles, "rakazo-c", "config.yaml"))
        assert c["platforms"]["a2a"]["port"] == 9902, c
        assert set(c["a2a_agents"]) == {"rakazo-a", "rakazo-b"}, c
        print("PASS sync_a2a_roster: stability + next-free allocation")

        env = os.path.join(tmp, "a.env")
        open(env, "w").write("FOO=1\nRAKAZO_TOKEN=old\n")
        set_env_line(env, "RAKAZO_TOKEN", "new")          # replace
        set_env_line(env, "RAKAZO_HOME_CHANNEL", "t1")    # append
        lines = open(env).read().splitlines()
        assert lines == ["FOO=1", "RAKAZO_TOKEN=new", "RAKAZO_HOME_CHANNEL=t1"], lines
        print("PASS set_env_line: replace + append")

        names = rakazo_profile_names(profiles)
        assert names == ["rakazo-a", "rakazo-b", "rakazo-bad", "rakazo-c"], names
        assert rakazo_profile_names(os.path.join(tmp, "nope")) == []
        print("PASS rakazo_profile_names: filter + missing dir")
    print("selftest OK")
    return 0


def main() -> None:
    if "--selftest" in sys.argv:
        sys.exit(selftest())
    if not API or not DEPLOY_TOKEN:
        sys.exit("RAKAZO_URL and RAKAZO_DEPLOY_TOKEN are required")
    headers = {"authorization": f"Bearer {DEPLOY_TOKEN}"}
    with httpx.Client(headers=headers, timeout=30.0) as client:
        pending = None  # result POST not yet acknowledged: {id, ok, detail}
        while True:
            try:
                # Re-POST a failed result before claiming the next command:
                # until it lands the command stays delivered with the token
                # plaintext still in its payload. Posting is idempotent for
                # delivered rows; 404 means it was already finalized.
                if pending:
                    res = client.post(
                        f"{API}/api/v1/hermes/commands/{pending['id']}/result",
                        json={"ok": pending["ok"], "detail": pending["detail"]},
                    )
                    if res.status_code in (200, 404):
                        pending = None
                    else:
                        time.sleep(10)
                        continue
                res = client.post(f"{API}/api/v1/hermes/commands/next")
                if res.status_code != 200:
                    time.sleep(10)
                    continue
                body = res.json()
                if body.get("timeout"):
                    continue
                cmd = {**body, "payload": json.loads(body["payload"])}
                handler = HANDLERS.get(cmd["action"])
                if handler is None:
                    ok, detail = False, f"unknown action {cmd['action']!r}"
                else:
                    ok, detail = handler(cmd)
                pending = {"id": cmd["id"], "ok": ok, "detail": detail}
                res = client.post(f"{API}/api/v1/hermes/commands/{cmd['id']}/result",
                                  json={"ok": ok, "detail": detail})
                if res.status_code in (200, 404):
                    pending = None
                print(f"[rakazo-supervisor] {cmd['action']} {cmd['payload'].get('name')}: {detail}", file=sys.stderr)
            except Exception as exc:  # ponytail: crash-loop 방지 최소 후프
                print(f"[rakazo-supervisor] {exc}", file=sys.stderr)
                time.sleep(10)


if __name__ == "__main__":
    main()
