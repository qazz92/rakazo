import asyncio
import os
import uuid

import httpx

from gateway.config import Platform
from gateway.platforms.base import (
    BasePlatformAdapter,
    MessageEvent,
    MessageType,
    SendResult,
)

POLL_PATH = "/api/v1/hermes/turns/next"
REPLY_PATH = "/api/v1/hermes/turns/{turn_id}/reply"
POLL_TIMEOUT_S = 30.0  # server holds 25s; margin for transport


class RakazoAdapter(BasePlatformAdapter):
    """Outbound-only long-poll adapter: this machine dials out, no inbound ports."""

    def __init__(self, config):
        # 소스 검증(irc/adapter.py:127): Platform은 동적 enum 멤버로 생성해 전달.
        # base __init__ 시그니처는 (config: PlatformConfig, platform: Platform).
        super().__init__(config, Platform("rakazo"))
        self.base_url = os.getenv("RAKAZO_URL", "").rstrip("/")
        self.token = os.getenv("RAKAZO_TOKEN", "")
        self._client: httpx.AsyncClient | None = None
        self._poll_task: asyncio.Task | None = None
        self._last_turn_by_chat: dict[str, str] = {}

    @staticmethod
    def platform_name() -> str:
        return "rakazo"

    def _headers(self) -> dict[str, str]:
        return {"authorization": f"Bearer {self.token}"}

    async def connect(self, *, is_reconnect: bool = False) -> bool:
        if not (self.base_url and self.token):
            return False
        # 재연결 시 이전 poll 태스크/클라이언트 정리 — 누수 방지(리뷰 #5).
        if self._poll_task:
            self._poll_task.cancel()
            try:
                await self._poll_task
            except (asyncio.CancelledError, Exception):
                pass
            self._poll_task = None
        if self._client:
            await self._client.aclose()
        self._client = httpx.AsyncClient(base_url=self.base_url, headers=self._headers(), timeout=POLL_TIMEOUT_S)
        self._poll_task = asyncio.create_task(self._poll_loop())
        self._mark_connected()
        return True

    async def disconnect(self) -> None:
        if self._poll_task:
            self._poll_task.cancel()
            try:
                await self._poll_task
            except (asyncio.CancelledError, Exception):
                pass
        if self._client:
            await self._client.aclose()
        self._mark_disconnected()

    async def _poll_loop(self) -> None:
        while True:
            try:
                res = await self._client.post(POLL_PATH)
                if res.status_code == 401:
                    # 401은 재시도로 절대 회복되지 않는다: generic except가
                    # 삼켜 무한 재시도하는 대신 base fatal-error 경로로 러너에
                    # 알리고 폴 루프를 종료한다(리뷰 #4, base.py:3712/3759).
                    self._set_fatal_error(
                        code="rakazo_auth",
                        message="rakazo token rejected (401) — reissue token",
                        retryable=False,
                    )
                    await self._notify_fatal_error()
                    return
                if res.status_code != 200:
                    await asyncio.sleep(5)
                    continue
                body = res.json()
                if body.get("timeout"):
                    continue
                # 소스 검증 확정: MessageEvent에 chat_id 필드는 없다 — 채팅은
                # source(SessionSource)에 싣고, build_source 헬퍼로 만든다
                # (dingtalk/adapter.py:741 패턴). 인바운드 metadata는 플러그인
                # 방향 자유 필드일 뿐 러너의 send 경로로 역류하지 않는다
                # (run.py는 모든 send에서 _thread_metadata_for_source로 새로
                # 만듦). RelayAdapter의 _scope_by_chat 패턴대로 어댑터 캐시가 정석.
                self._last_turn_by_chat[body["threadId"]] = body["id"]
                await self.handle_message(
                    MessageEvent(
                        text=body["prompt"],
                        message_type=MessageType.TEXT,
                        # user_id 필수: hermes authz는 신원 없는 인바운드를 정책과
                        # 무관하게 기각한다(authz_mixin.py:489). rakazo는 bearer 토큰이
                        # 이미 채널을 인증하므로 스레드 id를 안정 신원으로 쓴다.
                        source=self.build_source(
                            chat_id=body["threadId"], chat_type="dm",
                            user_id=body["threadId"], user_name="Rakazo",
                        ),
                        metadata={"turnId": body["id"]},
                    )
                )
            except asyncio.CancelledError:
                raise
            except Exception:
                await asyncio.sleep(5)  # ponytail: flat 5s backoff; jitter if flaps

    async def send(self, chat_id, content, reply_to=None, metadata=None):
        # turnId는 inbound에서 캐시한 것 사용(1스레드=1profile=순차 처리라 안전).
        # metadata가 오지 않는 것은 hermes 러너의 설계(gateway/run.py _thread_metadata_for_source).
        turn_id = self._last_turn_by_chat.get(chat_id, "ad-hoc")
        res = await self._client.post(
            REPLY_PATH.format(turn_id=turn_id),
            json={
                "threadId": chat_id,
                "text": content,
                "clientNonce": str(uuid.uuid4()),
            },
        )
        return SendResult(success=res.status_code == 200, message_id=res.json().get("messageId", ""))

    async def get_chat_info(self, chat_id):
        return {"name": chat_id, "type": "dm"}


def check_requirements() -> bool:
    return bool(os.getenv("RAKAZO_URL") and os.getenv("RAKAZO_TOKEN"))


def validate_config(config) -> bool:
    return check_requirements()


def _env_enablement() -> dict | None:
    if not check_requirements():
        return None
    seed = {"base_url": os.getenv("RAKAZO_URL", "")}
    home = os.getenv("RAKAZO_HOME_CHANNEL", "").strip()
    if home:
        seed["home_channel"] = {"chat_id": home, "name": "Rakazo"}
    return seed


async def _standalone_send(pconfig, chat_id, message, *, thread_id=None, media_files=None, force_document=False):
    """standalone_sender_fn용 발신기 — gateway 없이 cron deliver가 직접 쓴다.
    소스 검증(tools/send_message_tool.py:1076): 호출 시그니처는
    (pconfig, chat_id, chunk, *, thread_id, media_files, force_document)이고
    결과는 "success"/"error" 키를 가진 dict여야 한다(telegram _standalone_send 패턴).
    이 함수가 없으면 deliver=rakazo 크론잡이 "No live adapter"로 실패한다."""
    extra = getattr(pconfig, "extra", None) or {}  # env_enablement_fn이 base_url을 심는다
    base_url = (extra.get("base_url") or os.getenv("RAKAZO_URL", "")).rstrip("/")
    token = os.getenv("RAKAZO_TOKEN", "")
    client = httpx.AsyncClient(
        base_url=base_url,
        headers={"authorization": f"Bearer {token}"},
        timeout=30.0,
    )
    try:
        res = await client.post(
            REPLY_PATH.format(turn_id="ad-hoc"),
            json={"threadId": chat_id, "text": message, "clientNonce": str(uuid.uuid4())},
        )
        if res.status_code == 200:
            return {"success": True, "message_id": res.json().get("messageId", "")}
        return {"error": f"rakazo reply failed: HTTP {res.status_code}"}
    except asyncio.CancelledError:
        raise
    except Exception as e:
        return {"error": f"rakazo standalone send failed: {e}"}
    finally:
        await client.aclose()


def register(ctx):
    ctx.register_platform(
        name="rakazo",
        label="Rakazo",
        adapter_factory=lambda cfg: RakazoAdapter(cfg),
        check_fn=check_requirements,
        validate_config=validate_config,
        required_env=["RAKAZO_URL", "RAKAZO_TOKEN"],
        install_hint="Set RAKAZO_URL and RAKAZO_TOKEN (issue with the Rakazo API)",
        cron_deliver_env_var="RAKAZO_HOME_CHANNEL",
        standalone_sender_fn=_standalone_send,  # 소스 검증: cron deliver 필수 페어(없으면 "No live adapter")
        env_enablement_fn=_env_enablement,  # PlatformConfig.extra seed — home_channel로 cron-initiated send 라우팅
        max_message_length=4000,  # 리뷰修正: 0(무제한) → 폭주 방지 상한
        platform_hint=(
            "You are a Rakazo bot: an always-on teammate with your own "
            "computer. Take on work end-to-end and finish it — only come "
            "back to the user when something needs their approval or a "
            "decision. Remember how this user likes things done."
        ),
        emoji="🦊",
    )
