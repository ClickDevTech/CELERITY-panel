/**
 * OS-family helpers for remote nodes (linux = systemd, freebsd = rc.d).
 * Kept dependency-free so services can use them without pulling in nodeSetup.
 */

function normalizeOsFamily(unameOutput) {
    return /^freebsd$/i.test(String(unameOutput || '').trim()) ? 'freebsd' : 'linux';
}

function nodeOsFamily(node) {
    return node?.osFamily === 'freebsd' ? 'freebsd' : 'linux';
}

// rc.d script names use underscores (cc_agent) and their rc.conf knob is <name>_enable.
function buildServiceCommand(osFamily, verb, service) {
    if (osFamily === 'freebsd') {
        if (verb === 'enable') return `sysrc ${service}_enable=YES`;
        if (verb === 'disable') return `sysrc ${service}_enable=NO`;
        if (verb === 'is-active') return `service ${service} status >/dev/null 2>&1 && echo active || echo inactive`;
        if (verb === 'status') return `service ${service} status`;
        // rc.d services started via daemon(8) inherit our stdio: without the
        // redirects an SSH exec never sees EOF and hangs until the service dies.
        return `service ${service} ${verb} </dev/null >/dev/null 2>&1`;
    }
    return `systemctl ${verb} ${service}`;
}

// Host metrics scripts. The FreeBSD variants print the same line shapes as
// the Linux tools so one parser serves both (cpu line: idle at index 3).
function buildSystemStatsScript(osFamily) {
    if (osFamily === 'freebsd') {
        return `
echo "===CPUSAMPLE==="
sysctl -n kern.cp_time | awk '{print "cpu", $1, $2, $3, $5, 0, $4}'
echo "===LOADAVG==="
sysctl -n vm.loadavg | tr -d '{}' | awk '{print $1, $2, $3}'
echo "===CORES==="
sysctl -n hw.ncpu
echo "===MEM==="
PS=$(sysctl -n hw.pagesize); T=$(sysctl -n hw.physmem)
F=$(( ( $(sysctl -n vm.stats.vm.v_free_count) + $(sysctl -n vm.stats.vm.v_inactive_count) ) * PS ))
echo "Mem: $T $(( T - F )) $F"
echo "===DISK==="
df -k / | tail -1 | awk '{printf "%s %.0f %.0f %.0f %s %s\\n", $1, $2*1024, $3*1024, $4*1024, $5, $6}'
echo "===UPTIME==="
echo $(( $(date +%s) - $(sysctl -n kern.boottime | awk -F'[ =,]+' '{print $3}') ))
`;
    }
    return `
echo "===CPUSAMPLE==="
head -1 /proc/stat
echo "===LOADAVG==="
cat /proc/loadavg
echo "===CORES==="
nproc
echo "===MEM==="
free -b | grep -E "^Mem:"
echo "===DISK==="
df -B1 / | tail -1
echo "===UPTIME==="
cat /proc/uptime | cut -d' ' -f1
`;
}
function buildNetStatsCommand(osFamily) {
    if (osFamily === 'freebsd') {
        return `IF=$(route -n get default | awk '/interface:/{print $2}'); netstat -ibn -I "$IF" | awk -v i="$IF" '/<Link/ {printf "%s: %.0f 0 0 0 0 0 0 0 %.0f\\n", i, $8, $11}'`;
    }
    return `cat /proc/net/dev | grep -E '(eth|ens|enp|eno)' | head -1`;
}

module.exports = { normalizeOsFamily, nodeOsFamily, buildServiceCommand, buildSystemStatsScript, buildNetStatsCommand };
