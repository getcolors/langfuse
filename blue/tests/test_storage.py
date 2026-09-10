import json
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from conftest import fixture
from package_langfuse_blue import storage, validate

OPTS = fixture({"langfuse-storage-managed": True, "langfuse-storage-provider": "s3", "provider-backend": "s3", "s3-bucket": "owned-state", "s3-region": "us-east-1", "neon-r2-bucket": "owned-neon", "langfuse-s3-bucket": "owned-data", "langfuse-backup-r2-bucket": "owned-backup", "neon-r2-region": "us-east-1", "langfuse-backup-r2-region": "us-east-1"})
CREDENTIALS = {"credentials": {role: {"access_key_id": role + "-id", "secret_access_key": role + "-secret"} for role in ["neon", "data", "backup"]}}

def result(exit=0, out="", err=""):
    return SimpleNamespace(exit=exit, out=out, err=err)


def test_managed_s3_is_valid_without_r2_backend_or_operator_storage_keys():
    opts = {k: v for k, v in OPTS.items() if k not in ["r2-bucket", "r2-endpoint"]}
    assert not validate.state_errors(opts)
    assert len(validate.secret_errors(opts, "create")) == 4  # DNS and the three retained application secrets.
    for change in [{"neon-r2-region": "auto"}, {"s3-bucket": "owned-data"}, {"neon-r2-bucket": "owned-data"}, {"langfuse-storage-managed": "true"}, {"langfuse-backup-r2-region": "eu-west-1"}]:
        assert validate.state_errors({**opts, **change})


def test_each_storage_role_has_its_own_credential_environment():
    env = storage.credential_env({**OPTS, "langfuse/storage-credentials": CREDENTIALS})
    assert env["COLORS_PAR_NEON_R2_ACCESS_KEY_ID"] == "neon-id"
    assert env["COLORS_PAR_LANGFUSE_STORAGE_R2_ACCESS_KEY_ID"] == "data-id"
    assert env["COLORS_PAR_LANGFUSE_BACKUP_R2_ACCESS_KEY_ID"] == "backup-id"
    assert "AWS_ACCESS_KEY_ID" not in env
    with pytest.raises(RuntimeError):
        storage.credential_env(OPTS)


@pytest.mark.parametrize("probe", [result(), result(1, err="(403) Forbidden")])
async def test_refuses_untracked_existing_or_inaccessible_buckets(monkeypatch, probe):
    runner = AsyncMock(side_effect=[result(), result(), probe])
    monkeypatch.setattr(storage.runtime, "exec", runner)
    with pytest.raises(RuntimeError, match="refuses to adopt"):
        await storage.ownership_preflight(OPTS)


async def test_fresh_state_probes_all_three_buckets(monkeypatch):
    runner = AsyncMock(side_effect=[result(), result(1, err="No state file was found!"), *[result(254, err="(404) Not Found")] * 3])
    monkeypatch.setattr(storage.runtime, "exec", runner)
    await storage.ownership_preflight(OPTS)
    assert {call.args[0][4] for call in runner.call_args_list[2:]} == {"owned-neon", "owned-data", "owned-backup"}


async def test_existing_state_name_must_match_before_skipping_ownership_probe(monkeypatch):
    runner = AsyncMock(side_effect=[result(), result(out='aws_s3_bucket.application["neon"]'), result(out=json.dumps({"values": {"root_module": {"resources": [{"address": 'aws_s3_bucket.application["neon"]', "values": {"bucket": "old-name"}}]}}})), result()])
    monkeypatch.setattr(storage.runtime, "exec", runner)
    with pytest.raises(RuntimeError, match="refuses to adopt"):
        await storage.ownership_preflight(OPTS)


async def test_rehearsal_recovers_scoped_credentials_without_applying(monkeypatch, capsys):
    monkeypatch.setattr(storage.tofu, "conventional_backend_advice", lambda **kwargs: lambda opts: opts)
    monkeypatch.setattr(storage, "scaffold", lambda opts, specs: opts)
    runner = AsyncMock(return_value=result())
    monkeypatch.setattr(storage.runtime, "exec", runner)
    monkeypatch.setattr(storage.tofu, "outputs", AsyncMock(return_value=CREDENTIALS))
    opts = await storage.read_credentials(OPTS)
    assert opts["langfuse/storage-credentials"] == CREDENTIALS
    assert [call.args[0] for call in runner.call_args_list] == [["tofu", "init", "-input=false", "-no-color"]]
    assert not capsys.readouterr().out


async def test_adopted_mode_never_provisions(monkeypatch):
    runner = AsyncMock(side_effect=AssertionError("adopted mode must not call AWS"))
    monkeypatch.setattr(storage.runtime, "exec", runner)
    assert (await storage.storage_step({}))['blue/exit'] == 0
    assert not runner.called


async def test_sensitive_tofu_json_reaches_ansible(monkeypatch, capsys):
    wire = json.dumps({"credentials": {"sensitive": True, "type": ["object", {}], "value": CREDENTIALS["credentials"]}})
    runner = AsyncMock(return_value=result(out=wire))
    monkeypatch.setattr(storage.runtime, "exec", runner)
    decoded = await storage.tofu.outputs("/unused")
    env = storage.credential_env({**OPTS, "langfuse/storage-credentials": decoded})
    assert env["COLORS_PAR_NEON_R2_ACCESS_KEY_ID"] == "neon-id"
    assert env["COLORS_PAR_LANGFUSE_STORAGE_R2_SECRET_ACCESS_KEY"] == "data-secret"
    assert env["COLORS_PAR_LANGFUSE_BACKUP_R2_SECRET_ACCESS_KEY"] == "backup-secret"
    assert runner.call_args.args[0] == ["tofu", "output", "-json"]
    assert not capsys.readouterr().out
