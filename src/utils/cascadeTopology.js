/**
 * Input validation for the network map topology endpoints.
 */

const { z } = require('zod');

const MAX_POSITIONS = 1000;
const MAX_COORD = 1e6;

const coord = z.number().finite().min(-MAX_COORD).max(MAX_COORD);

const positionsSchema = z.object({
    positions: z.array(z.object({
        id: z.string().regex(/^[0-9a-fA-F]{24}$/),
        x: coord,
        y: coord,
    }).strict()).max(MAX_POSITIONS),
});

/**
 * Validate a POST /cascade/topology/positions body.
 * Returns { ok: true, positions } with coordinates rounded to 0.1px,
 * or { ok: false, error } with a short human-readable reason.
 */
function parsePositionsBody(body) {
    const result = positionsSchema.safeParse(body);
    if (!result.success) {
        const issue = result.error.issues[0];
        const where = issue?.path?.length ? issue.path.join('.') : 'body';
        return { ok: false, error: `invalid ${where}` };
    }
    const positions = result.data.positions.map(p => ({
        id: p.id,
        x: Math.round(p.x * 10) / 10,
        y: Math.round(p.y * 10) / 10,
    }));
    return { ok: true, positions };
}

module.exports = {
    parsePositionsBody,
    MAX_POSITIONS,
    MAX_COORD,
};
