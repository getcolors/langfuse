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
