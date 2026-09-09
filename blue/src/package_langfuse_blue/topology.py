"""Langfuse roles and connectivity; compute identity and resources are library owned."""
from __future__ import annotations
import re
from colors_compute.contract import collect, expand
from colors_compute.deployment_request import source_cidrs
from colors_compute.planning import plan_deployment

CLICKHOUSE_NODE_COUNT = 3
default_compute_provider = 'vultr'
ROLES = ['neon', 'redis', 'clickhouse', 'app']


def topology(opts):
    return [{'role': role, 'count': 3 if role == 'clickhouse' else 1} for role in ROLES]


def requirements(opts, http_ranges=None):
    if http_ranges is None:
        from .tools import http_sources
        http_ranges = http_sources({**opts, 'blue/event': 'build'})['ranges']
    ssh = {'id': 'ssh', 'protocol': 'tcp', 'from_port': 22, 'to_port': 22,
           'sources': source_cidrs(opts, 'ssh-sources', 'langfuse-ssh-sources')}
    def peer(id, port, roles):
        return {'id': id, 'protocol': 'tcp', 'from_port': port, 'to_port': port, 'peer_roles': roles}
    def policy(rules):
        return {'ingress': [ssh, *rules], 'egress': 'all', 'private_filter': True}
    return {'private': True, 'entry_node_id': 'app-0',
        'legacy_state_keys': [opts['profile'] + '/langfuse-infrastructure.tfstate'],
        'security': policy([]), 'roles': {
            'neon': {'security': policy([peer('postgres', NEON_COMPUTE_PORT, ['app'])])},
            'redis': {'security': policy([peer('redis', redis_port(opts), ['app'])])},
            'clickhouse': {'security': policy([
                *[peer('app-' + str(p), p, ['app']) for p in app_clickhouse_ports(opts)],
                *[peer('replica-' + str(p), p, ['clickhouse']) for p in clickhouse_internal_ports(opts)]])},
            'app': {'security': policy([{'id': 'http-' + str(p), 'protocol': 'tcp', 'from_port': p, 'to_port': p, 'sources': http_ranges} for p in (80, 443)])}}}


def _langfuse_host(node):
    host = dict(node)
    host['vpc-ip'] = host.pop('vpc_ip')
    if node['role'] != 'clickhouse':
        host['index'] = None
    return host


def hosts(opts, params=None):
    cluster = params if params is not None else opts.get('colors-compute/cluster')
    if cluster is None:
        if opts.get('blue/event') != 'build' and not opts.get('blue/dry-run'):
            raise ValueError('compute cluster unavailable')
        cluster = plan_deployment(opts, topology(opts), requirements(opts))['cluster']
    declarations = [{**node, 'private': True} for node in expand(topology(opts))]
    cluster = collect(declarations, cluster['nodes'], 'app-0')
    return [_langfuse_host(node) for node in cluster['nodes']]


def fallback_hosts(opts):
    return hosts({**opts, 'blue/event': 'build'})


def host_of(hosts_, role, i=None):
    return next((h for h in hosts_ if h.get('role') == role and h.get('index') == i), None)


def clickhouse_hosts(hosts_):
    return sorted((h for h in hosts_ if h.get('role') == 'clickhouse'), key=lambda h: h['index'])


def port(opts: dict, key: str, default: int) -> int:
    value = opts.get(key)
    if isinstance(value, int) and not isinstance(value, bool):
        return value
    if isinstance(value, str) and re.fullmatch(r"\d+", value):
        return int(value)
    return default


def clickhouse_http_port(opts: dict) -> int:
    return port(opts, "clickhouse-http-port", 8123)


def clickhouse_native_port(opts: dict) -> int:
    return port(opts, "clickhouse-native-port", 9000)


def clickhouse_interserver_port(opts: dict) -> int:
    return port(opts, "clickhouse-interserver-port", 9009)


def clickhouse_keeper_port(opts: dict) -> int:
    return port(opts, "clickhouse-keeper-port", 9181)


def clickhouse_raft_port(opts: dict) -> int:
    return port(opts, "clickhouse-raft-port", 9234)


def redis_port(opts: dict) -> int:
    return port(opts, "redis-port", 6379)


NEON_COMPUTE_PORT = 55433


def clickhouse_internal_ports(opts: dict) -> list[int]:
    """What the three replicas need from each other: the native port for
    distributed queries and `clusterAllReplicas`, interserver for part
    exchange, the Keeper client port, and raft."""
    return [clickhouse_native_port(opts), clickhouse_interserver_port(opts),
            clickhouse_keeper_port(opts), clickhouse_raft_port(opts)]


def app_clickhouse_ports(opts: dict) -> list[int]:
    """What the app host needs from ClickHouse: HTTP for queries, native for
    the migration runner. Never Keeper, never raft."""
    return [clickhouse_http_port(opts), clickhouse_native_port(opts)]
