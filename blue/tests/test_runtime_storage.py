"""Native S3 runtime configuration and privilege boundaries."""
import subprocess
import pytest
import yaml
from blue.scaffold import render_template
from conftest import fixture
from package_langfuse_blue import tools

@pytest.mark.parametrize("provider,expected", [("s3", "AWS"), ("r2", "Cloudflare")])
def test_runtime_remotes_use_matching_s3_provider(provider, expected):
    opts = fixture({"blue/event": "build", "langfuse-storage-provider": provider})
    if provider == "s3":
        opts.update({"neon-r2-endpoint": "https://s3.us-east-1.amazonaws.com", "langfuse-backup-r2-endpoint": "https://s3.us-east-1.amazonaws.com"})
    spec = next(s for s in tools.ansible_specs(opts) if s["target"].endswith("/r2-env.sh"))
    rendered = render_template(spec["template"], spec["data"], spec["opts"])
    # Execute only the configuration preamble, before reading host credential files.
    preamble = rendered[:rendered.index("if [ -f /etc/colors/store-r2.env ]")]
    result = subprocess.run(["bash", "-eu", "-c", preamble + '\nprintf "%s %s" "$RCLONE_CONFIG_STORE_PROVIDER" "$RCLONE_CONFIG_BACKUP_PROVIDER"'], text=True, capture_output=True, check=True)
    assert result.stdout == f"{expected} {expected}"

def test_all_remote_plays_escalate_for_ubuntu_ssh_users():
    opts = fixture({"blue/event": "build"})
    for spec in tools.ansible_specs(opts):
        name = spec["target"]
        if not name.endswith(".yml") or name.endswith(("compose.yml", "compose.override.yml")):
            continue
        rendered = render_template(spec["template"], spec["data"], spec["opts"])
        document = yaml.safe_load(rendered)
        if not isinstance(document, list):
            continue
        for play in document:
            if isinstance(play, dict) and "hosts" in play:
                assert play.get("become") is True, name

@pytest.mark.parametrize('failure', ['daemon-unavailable', 'container-stop-failed', 'container-still-running', 'service-stop-failed', 'service-still-running'])
def test_managed_cleanup_refuses_to_purge_if_writer_stop_is_unproven(tmp_path, failure):
    result = _run_managed_cleanup(tmp_path, failure)
    assert result.returncode != 0
    assert 'managed storage can be deleted' not in result.stdout


def test_managed_cleanup_proves_services_and_containers_stopped(tmp_path):
    result = _run_managed_cleanup(tmp_path, '')
    assert result.returncode == 0, result.stderr
    assert 'all writers stopped; managed storage can be deleted' in result.stdout
    calls = (tmp_path / 'calls').read_text()
    assert 'docker update --restart=no container-1' in calls
    assert 'docker stop --time 120 container-1' in calls
    assert 'systemctl stop clickhouse-server.service' in calls
    assert 'systemctl stop postgres-backup.service' in calls


def _run_managed_cleanup(tmp_path, failure):
    import os
    opts = fixture({'blue/event': 'build', 'langfuse-storage-managed': True})
    spec = next(s for s in tools.ansible_specs(opts) if s['target'].endswith('/cleanup.yml') and '/neon/' not in s['target'])
    rendered = render_template(spec['template'], spec['data'], spec['opts'])
    play = yaml.safe_load(rendered)[-1]
    assert play['any_errors_fatal'] is True
    script = play['tasks'][0]['ansible.builtin.shell']
    shim = tmp_path / 'shim'
    shim.write_text('''#!/usr/bin/env python3
import os,sys
from pathlib import Path
name=Path(sys.argv[0]).name
args=sys.argv[1:]
with open(os.environ['CALL_LOG'],'a') as f:f.write(name+' '+' '.join(args)+'\\n')
failure=os.environ['FAILURE']
if name=='systemctl':
 if args[0]=='show':
  if '--property=LoadState' in args:print('loaded' if args[1] in ('clickhouse-server.service','postgres-backup.service') else 'not-found')
  elif '--property=ActiveState' in args:print('active' if failure=='service-still-running' else 'inactive')
 elif args[0]=='stop' and failure=='service-stop-failed':sys.exit(1)
else:
 if args[0]=='ps':
  if failure=='daemon-unavailable':sys.exit(1)
  if '--all' in args or failure=='container-still-running':print('container-1')
 elif args[0]=='stop' and failure=='container-stop-failed':sys.exit(1)
''')
    shim.chmod(0o755)
    for name in ('systemctl', 'docker'):
        (tmp_path / name).symlink_to(shim)
    return subprocess.run(['bash', '-c', script], text=True, capture_output=True, env={**os.environ, 'PATH': str(tmp_path)+':'+os.environ['PATH'], 'CALL_LOG': str(tmp_path/'calls'), 'FAILURE': failure})
