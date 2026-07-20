"""팀원 인증 + 실시간 접속 현황.

- data/team.json (gitignore, Drive 동기화 전용) 에 멤버/시크릿 저장
- 멤버: {id, name, password(평문·관리자 열람용), role(admin|member), token(전용링크), created_at}
- 링크 /enter/<token> + 비밀번호 = 2요소 로그인
- 접속 현황은 메모리 heartbeat (휘발성, 실시간 표시용)
"""
import json
import secrets
import threading
import time
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TEAM_FILE = ROOT / "data" / "team.json"

_LOCK = threading.RLock()
_PRESENCE: dict[str, float] = {}   # member_id -> last ping (epoch)
ONLINE_WINDOW = 35                 # 초: 마지막 핑 이후 이 시간 안이면 접속중 (핑 15초 × 2 + 여유)


def _now_iso() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


def _read() -> dict:
    if TEAM_FILE.exists():
        try:
            with open(TEAM_FILE, encoding="utf-8") as f:
                d = json.load(f)
        except Exception:
            d = {}
    else:
        d = {}
    if not isinstance(d, dict):
        d = {}
    d.setdefault("members", [])
    return d


def _write(d: dict) -> None:
    TEAM_FILE.parent.mkdir(parents=True, exist_ok=True)
    tmp = TEAM_FILE.with_suffix(".tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(d, f, ensure_ascii=False, indent=2)
    tmp.replace(TEAM_FILE)


def load_team() -> dict:
    with _LOCK:
        d = _read()
        if not d.get("secret_key"):
            d["secret_key"] = secrets.token_hex(32)
            _write(d)
        return d


def get_secret() -> str:
    return load_team()["secret_key"]


def list_members() -> list[dict]:
    return load_team()["members"]


def has_admin() -> bool:
    return any(m.get("role") == "admin" for m in list_members())


def _admin_count(members) -> int:
    return sum(1 for m in members if m.get("role") == "admin")


def member_by_token(token: str):
    if not token:
        return None
    return next((m for m in list_members() if m.get("token") == token), None)


def member_by_id(mid: str):
    if not mid:
        return None
    return next((m for m in list_members() if m.get("id") == mid), None)


def _gen_token(existing: set) -> str:
    while True:
        t = secrets.token_urlsafe(9)
        if t not in existing:
            return t


def add_member(name: str, password: str, role: str = "member") -> dict:
    with _LOCK:
        d = load_team()
        tokens = {m.get("token") for m in d["members"]}
        m = {
            "id": "u_" + secrets.token_hex(5),
            "name": (name or "").strip() or "이름없음",
            "password": password or "",
            "role": "admin" if role == "admin" else "member",
            "token": _gen_token(tokens),
            "created_at": _now_iso(),
        }
        d["members"].append(m)
        _write(d)
        return m


def update_member(mid: str, name=None, password=None, role=None):
    with _LOCK:
        d = load_team()
        m = next((x for x in d["members"] if x.get("id") == mid), None)
        if not m:
            return None, "멤버를 찾을 수 없습니다"
        # 마지막 관리자를 일반으로 강등 방지
        if role == "member" and m.get("role") == "admin" and _admin_count(d["members"]) <= 1:
            return None, "마지막 관리자는 역할을 바꿀 수 없습니다"
        if name is not None and name.strip():
            m["name"] = name.strip()
        if password is not None and password != "":
            m["password"] = password
        if role in ("admin", "member"):
            m["role"] = role
        _write(d)
        return m, "ok"


def regen_token(mid: str):
    with _LOCK:
        d = load_team()
        m = next((x for x in d["members"] if x.get("id") == mid), None)
        if not m:
            return None
        tokens = {x.get("token") for x in d["members"] if x.get("id") != mid}
        m["token"] = _gen_token(tokens)
        _write(d)
        return m


def delete_member(mid: str):
    with _LOCK:
        d = load_team()
        m = next((x for x in d["members"] if x.get("id") == mid), None)
        if not m:
            return False, "멤버를 찾을 수 없습니다"
        if m.get("role") == "admin" and _admin_count(d["members"]) <= 1:
            return False, "마지막 관리자는 삭제할 수 없습니다"
        d["members"] = [x for x in d["members"] if x.get("id") != mid]
        _write(d)
        _PRESENCE.pop(mid, None)
        return True, "삭제됨"


# ── 실시간 접속 현황 (메모리 heartbeat) ──
def touch_presence(mid: str) -> None:
    if mid:
        _PRESENCE[mid] = time.time()


def drop_presence(mid: str) -> None:
    _PRESENCE.pop(mid, None)


def presence_status() -> dict:
    now = time.time()
    out = {}
    for mid, ts in list(_PRESENCE.items()):
        ago = int(now - ts)
        out[mid] = {"online": ago <= ONLINE_WINDOW, "ago": ago}
    return out
