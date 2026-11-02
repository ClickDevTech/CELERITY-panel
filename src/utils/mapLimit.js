/**
 * Run an async worker over items with at most `limit` in flight.
 * Results keep the input order.
 */
async function mapLimit(items, limit, worker) {
    const results = new Array(items.length);
    let nextIndex = 0;
    const workerCount = Math.min(Math.max(1, limit), items.length);

    async function run() {
        while (nextIndex < items.length) {
            const index = nextIndex;
            nextIndex += 1;
            results[index] = await worker(items[index], index);
        }
    }

    await Promise.all(Array.from({ length: workerCount }, run));
    return results;
}

module.exports = { mapLimit };
