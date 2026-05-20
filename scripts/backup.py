"""
넥스트포트 공구 워크스페이스 - 자동 백업 스크립트

매 작업 후 자동 실행. Google Drive 동기화 폴더로 누적 데이터 백업.

백업 위치:
  H:\\내 드라이브\\넥스트포트\\공구\\백업\\
    ├─ 최신\\         (가장 최근 상태, 덮어쓰기 — 빠른 복구용)
    └─ 히스토리\\     (타임스탬프별 archive, 30개 유지 — 롤백용)
       └─ 넥스트포트백업_2026-05-14_22-30-00\\

CLI 사용:
  python scripts/backup.py                      # 기본: 풀백업
  python scripts/backup.py --quick              # 빠른 백업 (5분 이내면 스킵)
  python scripts/backup.py --no-history         # 히스토리 안 만들고 최신만
  python scripts/backup.py --dst "다른경로"      # 백업 대상 폴더 변경
"""
from __future__ import annotations

import argparse
import json
import shutil
import sys
from datetime import datetime
from pathlib import Path

# Windows 콘솔(cp949)에서도 유니코드 출력 가능하게
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

# 프로젝트 루트
ROOT = Path(__file__).resolve().parent.parent

# 기본 백업 위치 (Google Drive 동기화 폴더)
DEFAULT_BACKUP_BASE = Path("H:/내 드라이브/넥스트포트/공구/백업")
FALLBACK_BACKUP_BASE = Path.home() / "Desktop" / "공구" / "백업"  # Drive 못 찾을 때

# 백업 대상 (디렉터리 또는 파일)
BACKUP_TARGETS = [
    # 데이터 (가장 중요)
    "data/campaigns.json",
    "data/meetings.json",
    "data/events.json",
    "data/products.json",
    "data/sellers.json",
    "data/schedules.json",  # legacy
    # 코드 (실수 복구용)
    "app.py",
    "templates/index.html",
    "static/app.js",
    "static/style.css",
    "modules/scraper.py",
    "modules/gemini.py",
    "modules/manifest.py",
    "modules/reindex.py",
    "modules/drive.py",
    "modules/schedule_gen.py",
    "modules/meeting_analyzer.py",
    "scripts/backup.py",
    # 설정 (config.json 은 API 키 포함이라 신중. 일단 포함)
    "config.json",
    "requirements.txt",
]

# 외부 백업 대상 (프로젝트 외부 파일)
EXTERNAL_TARGETS = [
    Path.home() / "Desktop" / "공구" / "작업로그.html",
    Path.home() / "Desktop" / "공구" / "대화로그_2026-05-01.txt",
]

# 히스토리 최대 개수
MAX_HISTORY = 30

# 빠른 백업 모드: 마지막 백업 후 이 시간(분) 이내면 스킵
QUICK_THRESHOLD_MIN = 5


def log(msg: str) -> None:
    print(f"[backup] {msg}")


def find_backup_base() -> Path:
    """Drive 폴더가 있으면 그쪽, 없으면 데스크탑."""
    if DEFAULT_BACKUP_BASE.exists() or DEFAULT_BACKUP_BASE.parent.exists():
        DEFAULT_BACKUP_BASE.mkdir(parents=True, exist_ok=True)
        return DEFAULT_BACKUP_BASE
    log(f"⚠ Drive 폴더 없음. fallback: {FALLBACK_BACKUP_BASE}")
    FALLBACK_BACKUP_BASE.mkdir(parents=True, exist_ok=True)
    return FALLBACK_BACKUP_BASE


def copy_targets(dst: Path) -> tuple[int, int]:
    """대상 파일들을 dst 폴더로 복사. 반환: (성공, 실패)."""
    ok, fail = 0, 0
    for rel in BACKUP_TARGETS:
        src = ROOT / rel
        if not src.exists():
            continue
        target = dst / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        try:
            shutil.copy2(src, target)
            ok += 1
        except Exception as e:
            log(f"  ✗ {rel}: {e}")
            fail += 1
    # 외부 대상 (작업로그 등)
    for src in EXTERNAL_TARGETS:
        if not src.exists():
            continue
        target = dst / "외부" / src.name
        target.parent.mkdir(parents=True, exist_ok=True)
        try:
            shutil.copy2(src, target)
            ok += 1
        except Exception as e:
            log(f"  ✗ {src.name}: {e}")
            fail += 1
    return ok, fail


def write_manifest(dst: Path, stats: dict) -> None:
    """백업 폴더 안에 README + manifest.json. 사용자가 바로 알아볼 수 있게."""
    readme = f"""넥스트포트 공구 워크스페이스 - 자동 백업
============================================

백업 시각: {stats['timestamp']}
파일 수: {stats['ok']}개 (실패 {stats['fail']}개)
백업 종류: {stats['kind']}

▶ 데이터 위치 (원본): {ROOT}
▶ 복구 방법: 이 폴더의 'data/*.json' 파일들을 원본 data 폴더에 덮어쓰면 됨.

⚠ 이 폴더는 자동 백업입니다. 직접 수정 금지.
"""
    (dst / "README.txt").write_text(readme, encoding="utf-8")
    (dst / "manifest.json").write_text(
        json.dumps(stats, ensure_ascii=False, indent=2), encoding="utf-8"
    )


def get_last_backup_time(base: Path) -> datetime | None:
    """최신 백업 시각 (manifest.json 기준)."""
    mf = base / "최신" / "manifest.json"
    if not mf.exists():
        return None
    try:
        data = json.loads(mf.read_text(encoding="utf-8"))
        return datetime.fromisoformat(data.get("timestamp", ""))
    except Exception:
        return None


def prune_history(history_dir: Path, keep: int = MAX_HISTORY) -> int:
    """히스토리 폴더에서 오래된 archive 정리. 반환: 삭제 개수."""
    if not history_dir.exists():
        return 0
    archives = sorted(
        [p for p in history_dir.iterdir() if p.is_dir()],
        key=lambda p: p.name,
        reverse=True,
    )
    deleted = 0
    for old in archives[keep:]:
        try:
            shutil.rmtree(old)
            deleted += 1
        except Exception as e:
            log(f"  ✗ prune {old.name}: {e}")
    return deleted


def run_backup(
    *,
    base: Path | None = None,
    quick: bool = False,
    no_history: bool = False,
) -> int:
    base = base or find_backup_base()
    now = datetime.now()
    now_iso = now.isoformat(timespec="seconds")
    stamp = now.strftime("%Y-%m-%d_%H-%M-%S")

    # quick 모드: 최근 5분 이내 백업 있으면 스킵
    if quick:
        last = get_last_backup_time(base)
        if last and (now - last).total_seconds() < QUICK_THRESHOLD_MIN * 60:
            log(f"⏭  quick mode: 마지막 백업 {(now - last).total_seconds():.0f}초 전 — 스킵")
            return 0

    log(f"백업 시작 → {base}")

    # 1. 최신 폴더로 백업 (덮어쓰기)
    latest = base / "최신"
    if latest.exists():
        try:
            shutil.rmtree(latest)
        except Exception as e:
            log(f"  ⚠ 최신 폴더 정리 실패: {e}")
    latest.mkdir(parents=True, exist_ok=True)

    ok, fail = copy_targets(latest)
    write_manifest(latest, {
        "timestamp": now_iso,
        "ok": ok, "fail": fail,
        "kind": "최신 (덮어쓰기)",
        "source": str(ROOT),
    })
    log(f"  ✓ 최신: {ok}개 복사 (실패 {fail}개)")

    # 2. 히스토리 archive
    if not no_history:
        archive = base / "히스토리" / f"넥스트포트백업_{stamp}"
        archive.mkdir(parents=True, exist_ok=True)
        ok2, fail2 = copy_targets(archive)
        write_manifest(archive, {
            "timestamp": now_iso,
            "ok": ok2, "fail": fail2,
            "kind": "히스토리 archive",
            "source": str(ROOT),
        })
        log(f"  ✓ 히스토리: {ok2}개 복사 → {archive.name}")

        # 오래된 archive 정리
        deleted = prune_history(base / "히스토리", MAX_HISTORY)
        if deleted:
            log(f"  ⊘ 오래된 archive {deleted}개 정리")

    log(f"백업 완료 ✓ ({now_iso})")
    return 0


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--quick", action="store_true", help="5분 이내 백업 있으면 스킵")
    parser.add_argument("--no-history", action="store_true", help="히스토리 archive 생략")
    parser.add_argument("--dst", type=str, default=None, help="백업 대상 폴더 직접 지정")
    args = parser.parse_args()

    base = Path(args.dst) if args.dst else None
    sys.exit(run_backup(base=base, quick=args.quick, no_history=args.no_history))


if __name__ == "__main__":
    main()
