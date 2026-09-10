import json
import pytest
from blue.workflow import run
from conftest import fixture, optout, PARAMS
from package_langfuse_blue import tools, topology, workflow as w
from test_validate import base, creds


def chain(event):
    step, result = 'langfuse/start', []
    while True:
        result.append(step)
        edge = w.wire_fn(step, {'blue/event': event})
        if len(edge) == 1:
            return result
        step = edge[1]


def test_application_order_keeps_dns_before_acme_and_cleanup_before_compute():
    assert chain('create') == ['langfuse/start','langfuse/infrastructure','langfuse/dns','langfuse/ssh-config','langfuse/ansible','langfuse/acceptance']
    assert chain('delete') == ['langfuse/start','langfuse/ansible','langfuse/ssh-config','langfuse/dns','langfuse/infrastructure']
    assert chain('rehearse') == ['langfuse/start','langfuse/rehearsal']
    assert chain('describe') == ['langfuse/start','langfuse/describe']


@pytest.mark.parametrize('load', [fixture, optout])
async def test_native_complete_build_renders_role_library_and_pinned_neon_without_credentials(load, tmp_path, monkeypatch):
    monkeypatch.setenv('HOME', str(tmp_path / 'empty-home'))
    monkeypatch.setattr(tools, 'fetch_cloudflare_ranges', lambda: pytest.fail('build must not fetch'))
    opts = load({'blue/event': 'build', 'workdir': str(tmp_path / 'render')})
    result = await run(w.create_workflow(), opts)
    assert result['blue/exit'] == 0, result.get('blue/err')
    root = tmp_path / 'render' / opts['profile']
    assert (root / 'compute/shared/shared-roles.tf.json').is_file()
    inventory = json.loads((root / 'langfuse-ansible/inventory.json').read_text())
    assert len(inventory['all']['children']['clickhouse']['hosts']) == 3
    assert (root / 'langfuse-ansible/neon/compose.yml').is_file()
    assert not (tmp_path / 'empty-home/.ssh').exists()
    assert result['colors-compute/cluster']['entry_node_id'] == 'app-0'


@pytest.mark.parametrize('event', ['delete', 'rehearse', 'describe'])
async def test_unreadable_or_legacy_state_refuses_application_steps(event, monkeypatch):
    async def unavailable(*args): return {'status': 'absent'}
    monkeypatch.setattr(w, 'read_deployment', unavailable)
    result = await w.start_step({**base, **creds, 'blue/event': event, 'compute-prevent-destroy': False}, {})
    assert result['blue/exit'] == 1
    assert 'explicit migration' in result['blue/err']


async def test_readonly_state_adoption_preserves_private_addresses_and_identity(monkeypatch):
    async def present(*args):
        return {'status': 'present', 'cluster': PARAMS, 'key': {'private_key_path': '/explicit/key'}}
    monkeypatch.setattr(w, 'read_deployment', present)
    result = await w.start_step({**base, **creds, 'blue/event': 'rehearse'}, {})
    assert result['blue/exit'] == 0
    assert tools.hosts(result)[-1]['vpc-ip'] == '10.50.0.7'
    assert result['ssh-private-key-path'] == '/explicit/key'


async def test_cloudflare_fallback_refuses_before_compute(monkeypatch):
    monkeypatch.setattr(tools, 'fetch_cloudflare_ranges', lambda: None)
    result = await tools.infrastructure_step({**base, 'blue/event': 'create'})
    assert result['blue/exit'] == 1
    assert 'stale fallback' in result['blue/err']


def test_dns_backend_credentials_remain_separate_from_compute():
    env = tools.credential_env({**base, **creds}, 'provider-dns')
    assert env['AWS_ACCESS_KEY_ID'] == 'state'
    assert env['AWS_SECRET_ACCESS_KEY'] == 'state-secret'
    assert env['CLOUDFLARE_API_TOKEN'] == 'c'
    assert 'VULTR_API_KEY' not in env

def test_managed_s3_order_keeps_backend_until_all_application_state_is_empty():
    def managed_chain(event):
        step, found = 'langfuse/start', []
        while True:
            found.append(step)
            edge = w.wire_fn(step, {'blue/event': event, 'langfuse-storage-managed': True, 's3-bucket-mode': 'managed'})
            if len(edge) == 1: return found
            step = edge[1]
    assert managed_chain('create') == ['langfuse/start','langfuse/infrastructure','langfuse/storage','langfuse/dns','langfuse/ssh-config','langfuse/ansible','langfuse/acceptance']
    assert managed_chain('delete') == ['langfuse/start','langfuse/ansible','langfuse/ssh-config','langfuse/dns','langfuse/storage','langfuse/infrastructure','langfuse/backend-finalize']


async def test_backend_finalization_delegates_and_keeps_failure_closed(monkeypatch):
    calls = []
    async def finalize(opts, env):
        calls.append((opts['profile'], env['AWS_ACCESS_KEY_ID']))
        return {'status': 'absent'}
    monkeypatch.setattr(w, 'finalize_backend', finalize)
    result = await w.backend_finalize_step({'profile':'example','aws-access-key-id':'fixture-access'})
    assert result['blue/exit'] == 0 and calls == [('example','fixture-access')]
    async def refuse(*_): raise ValueError('unowned state')
    monkeypatch.setattr(w, 'finalize_backend', refuse)
    assert (await w.backend_finalize_step({'profile':'example'}))['blue/exit'] == 1
