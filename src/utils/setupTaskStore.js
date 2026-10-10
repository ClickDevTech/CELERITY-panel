/**
 * In-memory progress store for background node auto-setup tasks.
 *
 * Progress, not state: capped log buffers, lazy TTL expiry. Covered by
 * scripts/test-setup-task-store.js.
 */

const MAX_LOGS = 300;
const TTL_MS = 30 * 60 * 1000;

const tasks = new Map();

function pushLog(task, line) {
    task.logs.push(line);
    if (task.logs.length > MAX_LOGS) {
        task.logs.splice(0, task.logs.length - MAX_LOGS);
    }
}

function createTask(nodeId) {
    const task = { status: 'running', logs: [], startedAt: Date.now(), finishedAt: null, error: null };
    tasks.set(String(nodeId), task);
    return task;
}

function getTask(nodeId) {
    const task = tasks.get(String(nodeId));
    if (!task) return null;
    if (task.status !== 'running' && Date.now() - (task.finishedAt || task.startedAt) > TTL_MS) {
        tasks.delete(String(nodeId));
        return null;
    }
    return task;
}

function finishTask(task, status, error = null) {
    task.status = status;
    task.error = error;
    task.finishedAt = Date.now();
}

function clearTasks() {
    tasks.clear();
}

module.exports = {
    MAX_LOGS,
    TTL_MS,
    pushLog,
    createTask,
    getTask,
    finishTask,
    clearTasks,
};
