/**
 * Small text sanitizers shared by panel/API/MCP and the public
 * subscription HTML page. No I/O, no dependencies.
 */

const USER_COMMENT_MAX = 500;
const PAGE_NOTE_MAX = 2000;

/**
 * Escape text for interpolation into an HTML document built from
 * template strings (the subscription landing page is not EJS).
 * @param {*} value
 * @returns {string}
 */
function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/**
 * Operator note on a user. Trimmed and capped; never used in auth.
 * @param {*} raw
 * @returns {string}
 */
function sanitizeUserComment(raw) {
    return String(raw || '').trim().slice(0, USER_COMMENT_MAX);
}

/**
 * Subscription-page instruction. Normalize newlines and cap length.
 * @param {*} raw
 * @returns {string}
 */
function sanitizePageNote(raw) {
    return String(raw || '')
        .replace(/\r\n/g, '\n')
        .replace(/[ \t]+\n/g, '\n')
        .trim()
        .slice(0, PAGE_NOTE_MAX);
}

/**
 * Escape a page note and turn remaining newlines into <br>.
 * Callers must pass the already-sanitized stored value.
 * @param {string} raw
 * @returns {string}
 */
function formatPageNoteHtml(raw) {
    return escapeHtml(raw).replace(/\n/g, '<br>');
}

module.exports = {
    USER_COMMENT_MAX,
    PAGE_NOTE_MAX,
    escapeHtml,
    sanitizeUserComment,
    sanitizePageNote,
    formatPageNoteHtml,
};
