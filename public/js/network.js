/**
 * Network topology visualization using cytoscape.js
 */

(function () {
    'use strict';

    if (typeof cytoscape === 'undefined') return;

    // Register dagre layout plugin
    if (typeof cytoscapeDagre !== 'undefined') {
        cytoscape.use(cytoscapeDagre);
    }

    const STATUS_COLORS = {
        online: '#22c55e',
        offline: '#ef4444',
        error: '#ef4444',
        syncing: '#eab308',
        deployed: '#3b82f6',
        pending: '#64748b',
    };

    const ROLE_LABELS = {
        standalone: '',
        entry: 'PORTAL',
        relay: 'RELAY',
        exit: 'BRIDGE',
    };

    let cy = null;
    let refreshTimer = null;

    // ==================== INIT ====================

    function init() {
        cy = cytoscape({
            container: document.getElementById('cy'),
            style: getCytoscapeStyle(),
            layout: { name: 'preset' },
            minZoom: 0.3,
            maxZoom: 3,
            wheelSensitivity: 0.3,
            boxSelectionEnabled: false,
        });

        cy.on('tap', 'node', onNodeTap);
        cy.on('tap', 'edge', onEdgeTap);
        cy.on('tap', function (e) {
            if (e.target === cy) closeDrawer();
        });
        cy.on('dragfree', 'node', onNodeDragEnd);

        document.getElementById('btnAutoLayout').addEventListener('click', runAutoLayout);
        document.getElementById('btnFitView').addEventListener('click', function () { cy.fit(50); });
        document.getElementById('btnRefresh').addEventListener('click', loadTopology);
        document.getElementById('btnAddLink').addEventListener('click', openAddLinkModal);
        document.getElementById('drawerClose').addEventListener('click', closeDrawer);
        document.getElementById('modalClose').addEventListener('click', closeModal);
        document.getElementById('modalCancel').addEventListener('click', closeModal);
        document.getElementById('addLinkForm').addEventListener('submit', onAddLinkSubmit);

        loadTopology();
        refreshTimer = setInterval(refreshStatuses, 30000);
    }

    // ==================== DATA LOADING ====================

    async function loadTopology() {
        showLoading(true);
        try {
            const res = await fetch('/api/cascade/topology');
            if (!res.ok) throw new Error('Failed to load topology');
            const data = await res.json();
            renderGraph(data);
        } catch (err) {
            console.error('Topology load error:', err);
        } finally {
            showLoading(false);
        }
    }

    async function refreshStatuses() {
        try {
            const res = await fetch('/api/cascade/topology');
            if (!res.ok) return;
            const data = await res.json();

            for (const n of data.nodes) {
                const ele = cy.getElementById(n.data.id);
                if (ele.length) {
                    ele.data('status', n.data.status);
                    ele.data('onlineUsers', n.data.onlineUsers);
                }
            }
            for (const e of data.edges) {
                const ele = cy.getElementById(e.data.id);
                if (ele.length) {
                    ele.data('status', e.data.status);
                    ele.data('latencyMs', e.data.latencyMs);
                }
            }
        } catch (_) {}
    }

    function renderGraph(data) {
        cy.elements().remove();

        const elements = [];

        for (const n of data.nodes) {
            const role = ROLE_LABELS[n.data.cascadeRole] || '';
            elements.push({
                group: 'nodes',
                data: {
                    ...n.data,
                    roleLabel: role,
                    displayLabel: `${n.data.flag || ''} ${n.data.label}`.trim(),
                    subtitle: n.data.ip + (n.data.onlineUsers ? ` (${n.data.onlineUsers})` : ''),
                },
                position: n.position || undefined,
            });
        }

        for (const e of data.edges) {
            elements.push({
                group: 'edges',
                data: {
                    ...e.data,
                    edgeLabel: buildEdgeLabel(e.data),
                },
            });
        }

        cy.add(elements);

        const hasPositions = data.nodes.some(n => n.position);
        if (hasPositions) {
            cy.fit(50);
        } else {
            runAutoLayout();
        }
    }

    function buildEdgeLabel(data) {
        const parts = [];
        if (data.tunnelPort) parts.push(':' + data.tunnelPort);
        if (data.latencyMs != null) parts.push(data.latencyMs + 'ms');
        return parts.join(' ') || '';
    }

    // ==================== CYTOSCAPE STYLE ====================

    function getCytoscapeStyle() {
        return [
            {
                selector: 'node',
                style: {
                    'shape': 'round-rectangle',
                    'width': 160,
                    'height': 64,
                    'background-color': '#1e1e2e',
                    'border-width': 2,
                    'border-color': function (ele) {
                        return STATUS_COLORS[ele.data('status')] || '#64748b';
                    },
                    'label': function (ele) {
                        return ele.data('displayLabel') || ele.data('label');
                    },
                    'text-valign': 'center',
                    'text-halign': 'center',
                    'color': '#e2e8f0',
                    'font-size': '12px',
                    'font-family': 'Inter, sans-serif',
                    'font-weight': 500,
                    'text-wrap': 'wrap',
                    'text-max-width': '140px',
                    'text-margin-y': -4,
                    'overlay-opacity': 0,
                },
            },
            {
                selector: 'node[subtitle]',
                style: {
                    'label': function (ele) {
                        const main = ele.data('displayLabel') || ele.data('label');
                        const sub = ele.data('subtitle') || '';
                        return main + '\n' + sub;
                    },
                },
            },
            {
                selector: 'node[roleLabel]',
                style: {
                    'label': function (ele) {
                        const role = ele.data('roleLabel');
                        const main = ele.data('displayLabel') || ele.data('label');
                        const sub = ele.data('subtitle') || '';
                        const prefix = role ? `[${role}] ` : '';
                        return prefix + main + '\n' + sub;
                    },
                },
            },
            {
                selector: 'node:selected',
                style: {
                    'border-width': 3,
                    'border-color': '#6366f1',
                    'background-color': 'rgba(99, 102, 241, 0.08)',
                },
            },
            {
                selector: 'node:active',
                style: {
                    'overlay-opacity': 0,
                },
            },
            {
                selector: 'edge',
                style: {
                    'width': 2,
                    'line-color': function (ele) {
                        return STATUS_COLORS[ele.data('status')] || '#64748b';
                    },
                    'target-arrow-color': function (ele) {
                        return STATUS_COLORS[ele.data('status')] || '#64748b';
                    },
                    'target-arrow-shape': 'triangle',
                    'curve-style': 'bezier',
                    'arrow-scale': 1.2,
                    'label': function (ele) { return ele.data('edgeLabel') || ''; },
                    'font-size': '10px',
                    'font-family': 'JetBrains Mono, monospace',
                    'color': '#94a3b8',
                    'text-background-color': '#0f0f1a',
                    'text-background-opacity': 0.8,
                    'text-background-padding': '3px',
                    'text-rotation': 'autorotate',
                    'overlay-opacity': 0,
                },
            },
            {
                selector: 'edge[status = "online"]',
                style: {
                    'line-style': 'solid',
                    'width': 2.5,
                    'line-dash-pattern': [6, 3],
                    'line-dash-offset': 0,
                },
            },
            {
                selector: 'edge:selected',
                style: {
                    'width': 3,
                    'line-color': '#6366f1',
                    'target-arrow-color': '#6366f1',
                },
            },
        ];
    }

    // ==================== LAYOUT ====================

    function runAutoLayout() {
        const layout = cy.layout({
            name: 'dagre',
            rankDir: 'LR',
            nodeSep: 80,
            rankSep: 150,
            edgeSep: 40,
            animate: true,
            animationDuration: 400,
            fit: true,
            padding: 50,
        });
        layout.run();
    }

    // ==================== INTERACTIONS ====================

    function onNodeTap(evt) {
        const node = evt.target;
        const d = node.data();
        const statusClass = d.status || 'offline';

        const html = `
            <div class="drawer-field">
                <div class="drawer-label">Status</div>
                <div class="drawer-status ${statusClass}">● ${d.status || 'unknown'}</div>
            </div>
            <div class="drawer-field">
                <div class="drawer-label">IP</div>
                <div class="drawer-value">${d.ip || '—'}</div>
            </div>
            <div class="drawer-field">
                <div class="drawer-label">Type</div>
                <div class="drawer-value">${d.type || '—'}</div>
            </div>
            <div class="drawer-field">
                <div class="drawer-label">Role</div>
                <div class="drawer-value">${d.cascadeRole || 'standalone'}</div>
            </div>
            <div class="drawer-field">
                <div class="drawer-label">Online Users</div>
                <div class="drawer-value">${d.onlineUsers || 0}</div>
            </div>
            <div class="drawer-field">
                <div class="drawer-label">Port</div>
                <div class="drawer-value">${d.port || '—'}</div>
            </div>
            <div class="drawer-actions">
                <a href="/panel/nodes/${d.id}" class="btn btn-sm btn-outline"><i class="ti ti-external-link"></i> Open Node</a>
            </div>
        `;

        document.getElementById('drawerTitle').textContent = (d.flag || '') + ' ' + (d.label || '');
        document.getElementById('drawerBody').innerHTML = html;
        document.getElementById('nodeDrawer').classList.add('open');
    }

    function onEdgeTap(evt) {
        const edge = evt.target;
        const d = edge.data();
        const statusClass = d.status || 'pending';

        const html = `
            <div class="drawer-field">
                <div class="drawer-label">Status</div>
                <div class="drawer-status ${statusClass}">● ${d.status || 'pending'}</div>
            </div>
            <div class="drawer-field">
                <div class="drawer-label">Tunnel Port</div>
                <div class="drawer-value">${d.tunnelPort || '—'}</div>
            </div>
            <div class="drawer-field">
                <div class="drawer-label">Protocol / Transport</div>
                <div class="drawer-value">${d.tunnelProtocol || 'vless'} / ${d.tunnelTransport || 'tcp'}</div>
            </div>
            <div class="drawer-field">
                <div class="drawer-label">Latency</div>
                <div class="drawer-value">${d.latencyMs != null ? d.latencyMs + ' ms' : '—'}</div>
            </div>
            <div class="drawer-actions">
                <button class="btn btn-sm btn-success" onclick="window._cascadeDeploy('${d.linkId}')">
                    <i class="ti ti-upload"></i> Deploy
                </button>
                <button class="btn btn-sm btn-outline" onclick="window._cascadeUndeploy('${d.linkId}')">
                    <i class="ti ti-upload-off"></i> Undeploy
                </button>
                <button class="btn btn-sm btn-danger" onclick="window._cascadeDelete('${d.linkId}')">
                    <i class="ti ti-trash"></i> Delete
                </button>
            </div>
        `;

        document.getElementById('drawerTitle').textContent = d.label || 'Cascade Link';
        document.getElementById('drawerBody').innerHTML = html;
        document.getElementById('nodeDrawer').classList.add('open');
    }

    function closeDrawer() {
        document.getElementById('nodeDrawer').classList.remove('open');
        cy.elements(':selected').unselect();
    }

    let positionSaveTimer = null;
    function onNodeDragEnd(evt) {
        clearTimeout(positionSaveTimer);
        positionSaveTimer = setTimeout(saveAllPositions, 500);
    }

    async function saveAllPositions() {
        const positions = cy.nodes().map(function (n) {
            const pos = n.position();
            return { id: n.data('id'), x: Math.round(pos.x), y: Math.round(pos.y) };
        });

        try {
            await fetch('/api/cascade/topology/positions', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ positions }),
            });
        } catch (_) {}
    }

    // ==================== ADD LINK MODAL ====================

    async function openAddLinkModal() {
        const modal = document.getElementById('addLinkModal');
        const portalSelect = document.getElementById('selectPortal');
        const bridgeSelect = document.getElementById('selectBridge');

        try {
            const res = await fetch('/api/nodes');
            if (!res.ok) throw new Error('Failed to fetch nodes');
            const nodes = await res.json();

            const options = nodes.map(function (n) {
                return '<option value="' + n._id + '">' + (n.flag || '') + ' ' + n.name + ' (' + n.ip + ')</option>';
            }).join('');

            portalSelect.innerHTML = '<option value="">— Select Portal —</option>' + options;
            bridgeSelect.innerHTML = '<option value="">— Select Bridge —</option>' + options;
        } catch (err) {
            portalSelect.innerHTML = '<option value="">Error loading nodes</option>';
            bridgeSelect.innerHTML = '<option value="">Error loading nodes</option>';
        }

        modal.classList.add('active');
    }

    function closeModal() {
        document.getElementById('addLinkModal').classList.remove('active');
        document.getElementById('addLinkForm').reset();
    }

    async function onAddLinkSubmit(e) {
        e.preventDefault();
        const form = e.target;
        const data = {
            name: form.name.value,
            portalNodeId: form.portalNodeId.value,
            bridgeNodeId: form.bridgeNodeId.value,
            tunnelPort: parseInt(form.tunnelPort.value) || 10086,
            tunnelProtocol: form.tunnelProtocol.value,
            tunnelTransport: form.tunnelTransport.value,
            tunnelSecurity: form.tunnelSecurity.value,
        };

        if (!data.name || !data.portalNodeId || !data.bridgeNodeId) {
            alert('Please fill in all required fields');
            return;
        }

        try {
            const res = await fetch('/api/cascade/links', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(data),
            });

            if (!res.ok) {
                const err = await res.json();
                alert('Error: ' + (err.error || 'Unknown error'));
                return;
            }

            closeModal();
            loadTopology();
        } catch (err) {
            alert('Network error: ' + err.message);
        }
    }

    // ==================== CASCADE ACTIONS ====================

    window._cascadeDeploy = async function (linkId) {
        if (!confirm('Deploy this cascade link?')) return;
        try {
            const res = await fetch('/api/cascade/links/' + linkId + '/deploy', { method: 'POST' });
            const data = await res.json();
            if (data.success) {
                loadTopology();
                closeDrawer();
            } else {
                alert('Deploy failed: ' + (data.error || 'Unknown error'));
            }
        } catch (err) {
            alert('Error: ' + err.message);
        }
    };

    window._cascadeUndeploy = async function (linkId) {
        if (!confirm('Undeploy this cascade link?')) return;
        try {
            await fetch('/api/cascade/links/' + linkId + '/undeploy', { method: 'POST' });
            loadTopology();
            closeDrawer();
        } catch (err) {
            alert('Error: ' + err.message);
        }
    };

    window._cascadeDelete = async function (linkId) {
        if (!confirm('Delete this cascade link? This will also undeploy it.')) return;
        try {
            await fetch('/api/cascade/links/' + linkId, { method: 'DELETE' });
            loadTopology();
            closeDrawer();
        } catch (err) {
            alert('Error: ' + err.message);
        }
    };

    // ==================== HELPERS ====================

    function showLoading(show) {
        let el = document.querySelector('.network-loading');
        if (show && !el) {
            el = document.createElement('div');
            el.className = 'network-loading';
            el.innerHTML = '<div class="spinner"></div> Loading topology...';
            document.querySelector('.network-container').appendChild(el);
        } else if (!show && el) {
            el.remove();
        }
    }

    // ==================== START ====================

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
