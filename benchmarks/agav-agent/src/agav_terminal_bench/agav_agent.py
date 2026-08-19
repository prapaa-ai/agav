"""
Harbor agent adapter for the agav CLI.

The agav GitHub repo is private, so it cannot be cloned inside a task container.
Instead we build a single-file agav executable from the *local* checkout ahead of
time (see ``benchmarks/agav-agent/build-binary.sh``) and upload that binary into
each task container. agav is then driven in non-interactive mode with
``agav run "<instruction>"``, which runs a single autonomous turn with
auto-accept permissions and exits with a status code.

Written against harbor's BaseInstalledAgent interface (install()/run()),
modelled on harbor's own built-in agents (see harbor/agents/installed/pi.py).
"""

import json
import os
import shlex
from pathlib import Path
from typing import Any, override

from harbor.agents.installed.base import (
    BaseInstalledAgent,
    CliFlag,
    with_prompt_template,
)
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext
from harbor.models.trajectories import (
    Agent,
    FinalMetrics,
    Observation,
    ObservationResult,
    Step,
    ToolCall,
    Trajectory,
)
from harbor.utils.trajectory_utils import format_trajectory_json

# Prebuilt binaries live in benchmarks/agav-agent/bin/ (this file is at
# benchmarks/agav-agent/src/agav_terminal_bench/agav_agent.py).
_BIN_DIR = Path(__file__).resolve().parents[2] / "bin"

# Where the uploaded binary lands inside the container.
_INSTALL_PATH = "/usr/local/bin/agav"
_OUTPUT_FILENAME = "agav.txt"

# agav writes its own native run transcript here (inside the container, under
# /logs/agent which maps to the agent's logs_dir on the host). We convert it into
# a Harbor ATIF trajectory.json in populate_context_post_run so the Hub uploader
# picks it up and leaderboard CI / the judge can audit every rewarded trial.
_NATIVE_TRAJECTORY_FILENAME = "agav-trajectory.json"

# `uname -m` (as reported inside the container) -> prebuilt binary filename.
# Terminal-Bench 2.0 task images are amd64/linux, so x86_64 is the common case.
_ARCH_BINARIES = {
    "x86_64": "agav-linux-x64",
    "amd64": "agav-linux-x64",
    "aarch64": "agav-linux-arm64",
    "arm64": "agav-linux-arm64",
}

# Map Harbor provider tokens -> agav provider names.
_PROVIDER_ALIASES = {
    "google": "gemini",
    "google-gemini": "gemini",
    "googleai": "gemini",
}

# Provider -> host env vars to forward into the container so agav can auth.
_PROVIDER_KEYS = {
    "anthropic": ["ANTHROPIC_API_KEY"],
    "openai": ["OPENAI_API_KEY"],
    "gemini": ["GEMINI_API_KEY"],
    "ollama": ["OLLAMA_HOST", "OLLAMA_PORT", "OLLAMA_ENDPOINT", "OLLAMA_API_KEY"],
}


class AgavAgent(BaseInstalledAgent):
    """Runs the agav CLI as a Terminal-Bench agent via Harbor."""

    # agav emits a native run transcript that we convert to ATIF (see
    # populate_context_post_run), so the Hub uploader has a trajectory.json per
    # trial — required for leaderboard submission / the judge's audit.
    SUPPORTS_ATIF: bool = True

    # Optional cap on agent iterations; set on the host via AGAV_MAX_TURNS.
    CLI_FLAGS = [
        CliFlag(
            "max_turns",
            cli="--max-turns",
            type="int",
            env_fallback="AGAV_MAX_TURNS",
        ),
    ]

    @staticmethod
    @override
    def name() -> str:
        return "agav"

    @override
    def get_version_command(self) -> str | None:
        return f"{_INSTALL_PATH} --version"

    @override
    def parse_version(self, stdout: str) -> str:
        return stdout.strip().splitlines()[-1].strip()

    def _local_binary_for_arch(self, arch: str) -> Path:
        """Resolve the host-side prebuilt binary for the container's arch."""
        name = _ARCH_BINARIES.get(arch.strip().lower())
        if name is None:
            raise RuntimeError(
                f"No prebuilt agav binary configured for container arch {arch!r}. "
                f"Known arches: {sorted(_ARCH_BINARIES)}."
            )
        binary = _BIN_DIR / name
        if not binary.is_file():
            raise RuntimeError(
                f"Prebuilt agav binary not found: {binary}\n"
                "Build it first from the repo root with:\n"
                "    benchmarks/agav-agent/build-binary.sh\n"
                "(builds a linux-x64 agav binary from your local checkout via Docker)."
            )
        return binary

    @override
    async def install(self, environment: BaseEnvironment) -> None:
        # Detect the container architecture so we upload a matching binary.
        arch_result = await self.exec_as_root(environment, command="uname -m")
        arch = (arch_result.stdout or "").strip()
        binary = self._local_binary_for_arch(arch)

        # docker cp the single-file executable straight to a PATH location, then
        # make it world-executable (docker cp lands it owned by root).
        await environment.upload_file(str(binary), _INSTALL_PATH)
        await self.exec_as_root(
            environment,
            command=f"chmod 755 {shlex.quote(_INSTALL_PATH)}",
        )

        # Sanity-check the uploaded binary runs in this container.
        await self.exec_as_agent(
            environment,
            command=f"{shlex.quote(_INSTALL_PATH)} --version",
        )

    @override
    @with_prompt_template
    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        if not self.model_name or "/" not in self.model_name:
            raise ValueError("Model name must be in the format provider/model_name")

        harbor_provider, model = self.model_name.split("/", 1)
        provider = _PROVIDER_ALIASES.get(harbor_provider.lower(), harbor_provider.lower())

        env: dict[str, str] = {}
        for key in _PROVIDER_KEYS.get(provider, []):
            val = os.environ.get(key)
            if val:
                env[key] = val

        # Anti reward-hacking egress control. When AGAV_EGRESS_PROXY is set on
        # the host, route ALL of the agent's HTTP(S) traffic (fetch_url tool AND
        # any shell curl/git) through a denylist proxy that refuses the benchmark
        # repo / leaked-solution mirrors. This is inert unless the var is set, so
        # normal direct-network runs are unaffected. It only touches the agent
        # phase's env (not any task file), so task_checksum is unchanged.
        # See benchmarks/egress-proxy.py. NO_PROXY keeps localhost task services
        # (webdrivers, local servers) off the proxy.
        proxy = os.environ.get("AGAV_EGRESS_PROXY")
        if proxy:
            for pkey in ("HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"):
                env[pkey] = proxy
            no_proxy = os.environ.get("AGAV_NO_PROXY", "localhost,127.0.0.1,::1")
            env["NO_PROXY"] = no_proxy
            env["no_proxy"] = no_proxy

        cli_flags = self.build_cli_flags()
        if cli_flags:
            cli_flags += " "

        escaped_instruction = shlex.quote(instruction)

        await self.exec_as_agent(
            environment,
            command=(
                "mkdir -p /logs/agent 2>/dev/null || true; "
                # `run` must come first, then the prompt, then flags.
                f"{shlex.quote(_INSTALL_PATH)} run {escaped_instruction} "
                f"--provider {shlex.quote(provider)} --model {shlex.quote(model)} "
                f"--trajectory /logs/agent/{_NATIVE_TRAJECTORY_FILENAME} "
                f"{cli_flags}"
                f"2>&1 | stdbuf -oL tee /logs/agent/{_OUTPUT_FILENAME}"
            ),
            env=env,
        )

    # ------------------------------------------------------------------
    # ATIF trajectory conversion
    # ------------------------------------------------------------------
    @staticmethod
    def _text_from_blocks(blocks: list[dict[str, Any]]) -> str:
        """Join the text of any ``text`` content blocks."""
        parts = [
            b["text"]
            for b in blocks
            if b.get("type") == "text" and b.get("text")
        ]
        return "\n".join(parts)

    def _convert_native_to_atif(self, data: dict[str, Any]) -> Trajectory | None:
        """Convert agav's native run transcript into a Harbor ATIF Trajectory.

        agav records the run as an ordered list of messages. A ``user`` message
        is either a real user turn (text blocks) or a batch of tool results
        (``tool_result`` blocks, correlated to a prior assistant turn by
        ``toolCallId``); an ``assistant`` message carries text plus ``tool_use``
        blocks. We map each user/assistant turn to a sequential ATIF Step and
        attach tool results as Observations on the agent step that issued them.
        """
        messages = data.get("messages") or []
        model_name = data.get("model") or self.model_name
        provider = data.get("provider") or ""

        steps: list[Step] = []
        step_id = 1

        for msg in messages:
            role = msg.get("role")
            content = msg.get("content") or []

            if role == "user":
                tool_results = [
                    b for b in content if b.get("type") == "tool_result"
                ]
                if tool_results:
                    # Attach each result to the agent step that issued the call.
                    for block in tool_results:
                        call_id = block.get("toolCallId") or ""
                        output = block.get("toolResult")
                        result = ObservationResult(
                            source_call_id=call_id,
                            content="" if output is None else str(output),
                        )
                        for step in reversed(steps):
                            if step.source != "agent" or not step.tool_calls:
                                continue
                            if any(
                                tc.tool_call_id == call_id
                                for tc in step.tool_calls
                            ):
                                if step.observation is None:
                                    step.observation = Observation(results=[result])
                                else:
                                    step.observation.results.append(result)
                                break
                    continue

                # Real user turn: prefer the original (pre-expansion) input.
                text = msg.get("sourceText") or self._text_from_blocks(content)
                steps.append(
                    Step(
                        step_id=step_id,
                        source="user",
                        message=text or "(no content)",
                    )
                )
                step_id += 1

            elif role == "assistant":
                text = self._text_from_blocks(content)
                tool_calls = [
                    ToolCall(
                        tool_call_id=b.get("toolCallId") or "",
                        function_name=b.get("toolName") or "",
                        arguments=b.get("toolInput") or {},
                    )
                    for b in content
                    if b.get("type") == "tool_use"
                ]
                step_kwargs: dict[str, Any] = {
                    "step_id": step_id,
                    "source": "agent",
                    "message": text or "(tool use)",
                    "model_name": model_name,
                }
                if tool_calls:
                    step_kwargs["tool_calls"] = tool_calls
                steps.append(Step(**step_kwargs))
                step_id += 1

        if not steps:
            return None

        usage = data.get("usage") or {}
        total_in = usage.get("input_tokens") or 0
        total_out = usage.get("output_tokens") or 0
        total_cache = usage.get("cache_read_tokens") or 0

        extra = {
            k: v
            for k, v in {
                "provider": provider or None,
                "started_at": data.get("started_at"),
                "finished_at": data.get("finished_at"),
            }.items()
            if v is not None
        }

        return Trajectory(
            agent=Agent(
                name=self.name(),
                version=self._version or "unknown",
                model_name=model_name,
            ),
            steps=steps,
            final_metrics=FinalMetrics(
                total_prompt_tokens=total_in or None,
                total_completion_tokens=total_out or None,
                total_cached_tokens=total_cache or None,
                total_cost_usd=None,
                total_steps=len(steps),
            ),
            extra=extra or None,
        )

    @override
    def populate_context_post_run(self, context: AgentContext) -> None:
        native_path = self.logs_dir / _NATIVE_TRAJECTORY_FILENAME
        if not native_path.is_file():
            return

        try:
            data = json.loads(native_path.read_text())
        except (OSError, json.JSONDecodeError) as exc:
            self.logger.debug(f"Failed to read agav native trajectory: {exc}")
            return

        try:
            trajectory = self._convert_native_to_atif(data)
        except Exception:
            self.logger.debug(
                "Failed to convert agav trajectory to ATIF", exc_info=True
            )
            return

        if trajectory is None:
            return

        atif_path = self.logs_dir / "trajectory.json"
        try:
            atif_path.write_text(format_trajectory_json(trajectory.to_json_dict()))
        except OSError as exc:
            self.logger.debug(f"Failed to write ATIF trajectory {atif_path}: {exc}")
            return

        if trajectory.final_metrics:
            fm = trajectory.final_metrics
            context.cost_usd = fm.total_cost_usd
            context.n_input_tokens = fm.total_prompt_tokens or 0
            context.n_output_tokens = fm.total_completion_tokens or 0
            context.n_cache_tokens = fm.total_cached_tokens or 0
